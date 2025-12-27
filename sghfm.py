import torch
import torch.nn as nn
import torch.nn.functional as F
import numpy as np
import time
import math

# ============================================================================
# SPARSE GEOMETRIC HEBBIAN FIELD MODEL (SGHFM)
# Fusion of: BDH + Emulative Field Dynamics
# ============================================================================

def get_quantized_freqs(n, theta=2**16, dtype=torch.float32):
    """Quantized RoPE frequencies (BDH hierarchical position encoding)"""
    def quantize(t, q=2):
        return (t / q).floor() * q

    freqs = 1.0 / (theta ** (quantize(torch.arange(0, n, 1, dtype=dtype)) / n))
    return freqs / (2 * math.pi)


class QuantizedRoPE(nn.Module):
    """BDH's quantized RoPE for hierarchical position encoding"""

    def __init__(self, dim):
        super().__init__()
        self.register_buffer('freqs', get_quantized_freqs(dim).view(1, 1, 1, dim))

    @staticmethod
    def phases_cos_sin(phases):
        phases = (phases % 1) * (2 * math.pi)
        return torch.cos(phases), torch.sin(phases)

    @staticmethod
    def apply_rope(phases, v):
        """Apply rotation using phases"""
        v_rot = torch.stack((-v[..., 1::2], v[..., ::2]), dim=-1).view(*v.size())
        phases_cos, phases_sin = QuantizedRoPE.phases_cos_sin(phases)
        return (v * phases_cos).to(v.dtype) + (v_rot * phases_sin).to(v.dtype)

    def forward(self, x, start_pos=0):
        """Apply RoPE to tensor x"""
        B, T, D = x.shape
        positions = torch.arange(start_pos, start_pos + T, device=x.device, dtype=self.freqs.dtype)
        r_phases = positions.view(1, -1, 1, 1) * self.freqs
        return self.apply_rope(r_phases, x.unsqueeze(2)).squeeze(2)


class DynamicMetric(nn.Module):
    """
    Emulative: Dynamic DIAGONAL metric tensor that responds to field state
    Operates in BDH's sparse space
    """

    def __init__(self, sparse_dim, num_heads):
        super().__init__()
        self.num_heads = num_heads
        self.head_dim = sparse_dim // num_heads

        # Network that computes metric DIAGONAL from field state
        self.metric_network = nn.Sequential(
            nn.Linear(sparse_dim, sparse_dim // 2),
            nn.GELU(),
            nn.Linear(sparse_dim // 2, num_heads * self.head_dim) # Output diagonal
        )

        # Base metric diagonal (learned bias)
        self.base_metric_diag = nn.Parameter(
            torch.ones(num_heads, self.head_dim) * 0.1
        )

    def forward(self, field_state):
        """
        Compute DIAGONAL metric from current sparse field configuration
        Like how matter curves spacetime
        """
        B, T, N = field_state.shape

        # Global + local field signatures (addresses metric collapse)
        field_signature = field_state.mean(dim=1)  # Global
        if T >= 8:
            field_signature = field_signature + field_state[:, ::8].mean(dim=1) * 0.5  # Coarse local

        # Generate metric modulation for the diagonal
        metric_diag_flat = self.metric_network(field_signature)
        metric_diag_modulation = metric_diag_flat.view(B, self.num_heads, self.head_dim)

        # Combine with base metric
        metric_diag = self.base_metric_diag.unsqueeze(0) + 0.1 * metric_diag_modulation

        # Ensure positivity (metric diagonal must be > 0 for stability)
        metric_diag = F.softplus(metric_diag) + 1e-6

        return metric_diag


class SparseGeometricInteraction(nn.Module):
    """
    Fusion: BDH sparse encoding + Emulative local geometric interaction
    """

    def __init__(self, dense_dim, sparse_dim, num_heads=8, k_neighbors=32):
        super().__init__()
        self.dense_dim = dense_dim
        self.sparse_dim = sparse_dim
        self.num_heads = num_heads
        self.head_dim = sparse_dim // num_heads
        self.k = k_neighbors

        # BDH: Sparse encoder (D → N expansion)
        self.encoder_query = nn.Parameter(torch.randn(num_heads, dense_dim, self.head_dim) * 0.02)
        self.encoder_value = nn.Parameter(torch.randn(num_heads, dense_dim, self.head_dim) * 0.02)

        # Emulative: Dynamic metric in sparse space
        self.dynamic_metric = DynamicMetric(sparse_dim, num_heads)

        # BDH: Sparse decoder (N → D)
        self.decoder = nn.Parameter(torch.randn(num_heads * self.head_dim, dense_dim) * 0.02)

        # Hebbian state (fast weights)
        self.register_buffer(
            'hebbian_state',
            torch.zeros(num_heads, self.head_dim, self.head_dim)
        )

    def forward(self, x, return_sparsity=False):
        """
        Complete forward pass:
        1. BDH sparse encoding + Hebbian update
        2. Emulative geometric interaction (causal windowed, O(T*k))
        3. Multiplicative gating
        4. BDH sparse decoding
        """
        B, T, D = x.shape
        device = x.device

        # === PHASE 1: BDH SPARSE ENCODING & HEBBIAN UPDATE ===
        query_latent = torch.einsum('btd,nde->btne', x, self.encoder_query)
        query_sparse = F.relu(query_latent)

        value_latent = torch.einsum('btd,nde->btne', x, self.encoder_value)
        value_sparse = F.relu(value_latent)

        sparsity = (query_sparse == 0).float().mean().item()

        if self.training:
            with torch.no_grad():
                update = torch.einsum('btnd,btne->nde', query_sparse, value_sparse)
                update /= (B * T)
                self.hebbian_state.mul_(0.99).add_(update, alpha=0.01)

        # === PHASE 2: EMULATIVE DYNAMIC METRIC ===
        query_flat = query_sparse.flatten(2)
        metric_diag_tensor = self.dynamic_metric(query_flat)  # (B, nh, hd)

        # === PHASE 3: EFFICIENT LOCAL GEOMETRIC INTERACTION ===
        k_actual = min(self.k, T)
        if k_actual == 0:
            context = torch.zeros_like(query_sparse)
        else:
            # Pad for causal windowing
            q_padded = F.pad(query_sparse, (0, 0, 0, 0, k_actual - 1, 0), 'constant', 0)
            v_padded = F.pad(value_sparse, (0, 0, 0, 0, k_actual - 1, 0), 'constant', 0)

            # Create sliding windows: (B, T, nh, hd, k) -> (B, T, nh, k, hd)
            q_windows = q_padded.unfold(1, k_actual, 1).permute(0, 1, 2, 4, 3)
            v_windows = v_padded.unfold(1, k_actual, 1).permute(0, 1, 2, 4, 3)

            # Prepare queries for broadcasting: (B, T, nh, 1, hd)
            q_target = query_sparse.unsqueeze(3)

            # Difference tensor: (B, T, nh, k, hd)
            diff = q_target - q_windows

            # Apply diagonal metric: (B, nh, 1, 1, hd) * diff^2 -> sum -> (B, T, nh, k)
            metric_diag_bc = metric_diag_tensor.unsqueeze(1).unsqueeze(3)
            dist_sq = torch.sum(metric_diag_bc * diff.pow(2), dim=-1)
            distances = torch.sqrt(dist_sq + 1e-8)

            # Geometric influence kernel: (B, T, nh, k)
            influence = torch.exp(-distances)
            influence = influence / (influence.sum(dim=-1, keepdim=True) + 1e-8)

            # Field integration: (B, T, nh, k) @ (B, T, nh, k, hd) -> (B, T, nh, hd)
            context = torch.einsum('btnk,btnkd->btnd', influence, v_windows)

        # Add Hebbian contribution
        hebbian_context = torch.einsum('btnd,nde->btne', F.normalize(query_sparse, dim=-1), self.hebbian_state)
        context = context + hebbian_context

        # === PHASE 4: BDH MULTIPLICATIVE GATING ===
        output_sparse = query_sparse * context

        # === PHASE 5: BDH SPARSE DECODING ===
        output_flat = output_sparse.flatten(2)
        output_dense = output_flat @ self.decoder

        if return_sparsity:
            return output_dense, sparsity
        return output_dense


class AdaptiveFieldEvolution(nn.Module):
    """
    Complete evolution block with:
    - Sparse geometric interaction
    - Energy conservation
    - Adaptive time stepping
    """

    def __init__(self, dense_dim, sparse_dim, num_heads=8, k_neighbors=32, dropout=0.1):
        super().__init__()

        # Sparse geometric interaction
        self.interaction = SparseGeometricInteraction(
            dense_dim, sparse_dim, num_heads, k_neighbors
        )

        # Local flow dynamics (BDH-style)
        self.flow = nn.Sequential(
            nn.Linear(dense_dim, dense_dim * 4),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(dense_dim * 4, dense_dim),
            nn.Dropout(dropout)
        )

        # Coherence constraints
        self.norm1 = nn.LayerNorm(dense_dim)
        self.norm2 = nn.LayerNorm(dense_dim)

        # Energy tracking
        self.energy_proj = nn.Linear(dense_dim, 1)

    def compute_energy(self, x):
        """
        Emulative: Compute field energy for conservation
        Energy = kinetic (field magnitude) + potential (gradients)
        """
        # Kinetic: field magnitude
        kinetic = torch.sum(x ** 2, dim=-1)  # (B, T)

        # Potential: spatial variation (gradient energy)
        if x.size(1) > 1:
            gradient = x[:, 1:, :] - x[:, :-1, :]
            potential = torch.sum(gradient ** 2, dim=-1)
            # Pad to match kinetic shape
            potential = F.pad(potential, (0, 1), value=0)
        else:
            potential = torch.zeros_like(kinetic)

        total_energy = kinetic + 0.1 * potential
        return total_energy.mean()

    def compute_field_velocity(self, x):
        """Compute dX/dt - the rate of field change"""
        # Geometric interaction component
        dx_interaction, sparsity = self.interaction(self.norm1(x), return_sparsity=True)

        # Local flow component
        dx_flow = self.flow(self.norm2(x))

        return dx_interaction + dx_flow, sparsity

    def forward(self, x, return_energy=False, return_sparsity=False):
        """Single evolution step with energy tracking"""
        # Compute velocity
        dx, sparsity = self.compute_field_velocity(x)

        # Evolve field
        x_new = x + dx

        # Compute energy
        energy = self.compute_energy(x_new) if return_energy else None

        if return_energy and return_sparsity:
            return x_new, energy, sparsity
        elif return_energy:
            return x_new, energy
        elif return_sparsity:
            return x_new, sparsity
        return x_new


class SGHFM(nn.Module):
    """
    Sparse Geometric Hebbian Field Model

    Complete fusion of:
    - BDH: Sparse encoding, Hebbian learning, multiplicative gating, quantized RoPE
    - Emulative: Dynamic metrics, adaptive evolution, energy conservation, boundary conditions
    """

    def __init__(self, vocab_size, dense_dim=256, sparse_dim=2048, num_heads=8,
                 k_neighbors=32, max_evolution_steps=8, convergence_threshold=0.01,
                 block_size=128, dropout=0.1):
        super().__init__()

        self.vocab_size = vocab_size
        self.dense_dim = dense_dim
        self.sparse_dim = sparse_dim
        self.block_size = block_size
        self.max_evolution_steps = max_evolution_steps
        self.convergence_threshold = convergence_threshold

        print(f"SGHFM Architecture:")
        print(f"  Dense dim (D): {dense_dim}")
        print(f"  Sparse dim (N): {sparse_dim} ({sparse_dim//dense_dim}x expansion)")
        print(f"  Sparsity target: ~95% (ReLU)")
        print(f"  Heads: {num_heads}")
        print(f"  k-NN: {k_neighbors}")

        # Tokens as boundary perturbations (Emulative)
        self.token_to_perturbation = nn.Embedding(vocab_size, dense_dim)

        # Quantized RoPE for hierarchical position (BDH)
        self.rope = QuantizedRoPE(dense_dim)

        # Field initialization
        self.field_init = nn.Parameter(torch.randn(1, 1, dense_dim) * 0.02)

        # Single shared evolution operator (BDH principle)
        self.evolution_operator = AdaptiveFieldEvolution(
            dense_dim, sparse_dim, num_heads, k_neighbors, dropout
        )

        # Energy target for conservation
        self.register_buffer('target_energy', torch.tensor(1.0))
        self.register_buffer('prev_energy', torch.tensor(1.0))

        # Observer interface
        self.final_norm = nn.LayerNorm(dense_dim)
        self.to_logits = nn.Linear(dense_dim, vocab_size)

        self.apply(self._init_weights)

    def _init_weights(self, module):
        if isinstance(module, nn.Linear):
            torch.nn.init.normal_(module.weight, mean=0.0, std=0.02)
            if module.bias is not None:
                torch.nn.init.zeros_(module.bias)
        elif isinstance(module, nn.Embedding):
            torch.nn.init.normal_(module.weight, mean=0.0, std=0.02)

    def initialize_field(self, batch_size, seq_len, device):
        """Initialize base field state"""
        return self.field_init.expand(batch_size, seq_len, -1)

    def apply_boundary_conditions(self, field_state, tokens):
        """
        Emulative: Tokens PERTURB the field, don't define it
        This is the key conceptual shift
        """
        # Token perturbations
        perturbations = self.token_to_perturbation(tokens)

        # Apply hierarchical position encoding (BDH)
        perturbations = self.rope(perturbations)

        # Perturb the field
        return field_state + perturbations

    def evolve_field_adaptive(self, field_state, training=True):
        """
        Emulative: Adaptive evolution until convergence
        BDH: Shared evolution operator
        """
        energies = []
        sparsities = []
        prev_energy = self.prev_energy.item()

        t = 0
        steps = 0
        max_steps = self.max_evolution_steps

        for step in range(max_steps):
            # Evolve
            field_new, energy, sparsity = self.evolution_operator(
                field_state, return_energy=True, return_sparsity=True
            )

            energies.append(energy)
            sparsities.append(sparsity)

            # Check convergence (only during inference)
            if not training and step > 0:
                delta = torch.norm(field_new - field_state) / (torch.norm(field_state) + 1e-8)
                if delta < self.convergence_threshold:
                    steps = step + 1
                    break

            field_state = field_new
            steps = step + 1

        # Energy conservation: penalize CHANGE in energy, not absolute value
        # This allows strong fields but prevents instability
        if len(energies) > 1:
            energy_changes = [(energies[i] - energies[i-1])**2 for i in range(1, len(energies))]
            energy_loss = sum(energy_changes) / len(energy_changes)
        else:
            energy_loss = torch.tensor(0.0, device=field_state.device)

        # Update tracked energy
        if len(energies) > 0:
            self.prev_energy = energies[-1].detach()

        avg_sparsity = sum(sparsities) / len(sparsities) if sparsities else 0.0

        return field_state, energy_loss, steps, avg_sparsity

    def forward(self, idx, targets=None):
        B, T = idx.shape
        device = idx.device

        # Initialize field
        field_state = self.initialize_field(B, T, device)

        # Apply tokens as boundary conditions
        field_state = self.apply_boundary_conditions(field_state, idx)

        # Evolve field until stable
        field_state, energy_loss, steps, sparsity = self.evolve_field_adaptive(
            field_state,
            training=self.training
        )

        # Observe stabilized patterns
        field_state = self.final_norm(field_state)
        logits = self.to_logits(field_state)

        # Compute loss
        loss = None
        if targets is not None:
            ce_loss = F.cross_entropy(
                logits.view(-1, self.vocab_size),
                targets.view(-1)
            )

            # Add energy conservation (penalize instability, not magnitude)
            loss = ce_loss + 0.005 * energy_loss

        return logits, loss, steps, sparsity

    @torch.no_grad()
    def generate(self, idx, max_new_tokens, temperature=1.0, top_k=None):
        """Generate by evolving field autoregressively"""

        for _ in range(max_new_tokens):
            idx_cond = idx if idx.size(1) <= self.block_size else idx[:, -self.block_size:]

            logits, _, _, _ = self(idx_cond)
            logits = logits[:, -1, :] / temperature

            if top_k is not None:
                v, _ = torch.topk(logits, min(top_k, logits.size(-1)))
                logits[logits < v[:, [-1]]] = -float('Inf')

            probs = F.softmax(logits, dim=-1)
            idx_next = torch.multinomial(probs, num_samples=1)
            idx = torch.cat((idx, idx_next), dim=1)

        return idx


# ============================================================================
# TRAINING
# ============================================================================

def get_batch(data, block_size, batch_size, device):
    ix = torch.randint(len(data) - block_size, (batch_size,))
    x = torch.stack([data[i:i+block_size] for i in ix])
    y = torch.stack([data[i+1:i+block_size+1] for i in ix])
    return x.to(device), y.to(device)


@torch.no_grad()
def estimate_loss(model, data, block_size, batch_size, device, eval_iters=10):
    model.eval()
    losses = []
    for _ in range(eval_iters):
        X, Y = get_batch(data, block_size, batch_size, device)
        _, loss, _, _ = model(X, Y)
        losses.append(loss.item())
    model.train()
    return np.mean(losses)


def train_sghfm():
    """Train Sparse Geometric Hebbian Field Model"""

    print("=" * 80)
    print("SPARSE GEOMETRIC HEBBIAN FIELD MODEL (SGHFM)")
    print("Fusion of BDH + Emulative Field Dynamics")
    print("=" * 80)

    # Data loading
    print("\n[1/5] Loading TinyShakespeare...")

    import urllib.request
    import os

    if not os.path.exists('input.txt'):
        url = 'https://raw.githubusercontent.com/karpathy/char-rnn/master/data/tinyshakespeare/input.txt'
        urllib.request.urlretrieve(url, 'input.txt')

    with open('input.txt', 'r', encoding='utf-8') as f:
        text = f.read()

    chars = sorted(list(set(text)))
    vocab_size = len(chars)
    stoi = {ch: i for i, ch in enumerate(chars)}
    itos = {i: ch for i, ch in enumerate(chars)}
    encode = lambda s: [stoi[c] for c in s]
    decode = lambda l: ''.join([itos[i] for i in l])

    data = torch.tensor(encode(text), dtype=torch.long)
    n = int(0.9 * len(data))
    train_data = data[:n]
    val_data = data[n:]

    print(f"Dataset: {len(text)} chars, {vocab_size} vocab")

    # Model setup
    print("\n[2/5] Initializing SGHFM...")

    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    print(f"Device: {device}")

    config = {
        'vocab_size': vocab_size,
        'dense_dim': 256,
        'sparse_dim': 2048,  # 8x expansion like BDH paper
        'num_heads': 8,
        'k_neighbors': 32,
        'max_evolution_steps': 8,
        'convergence_threshold': 0.01,
        'block_size': 128,
        'dropout': 0.1,
        'batch_size': 64,
        'learning_rate': 3e-4,
        'max_iters': 5000,
        'eval_interval': 50
    }

    model = SGHFM(
        vocab_size=config['vocab_size'],
        dense_dim=config['dense_dim'],
        sparse_dim=config['sparse_dim'],
        num_heads=config['num_heads'],
        k_neighbors=config['k_neighbors'],
        max_evolution_steps=config['max_evolution_steps'],
        convergence_threshold=config['convergence_threshold'],
        block_size=config['block_size'],
        dropout=config['dropout']
    ).to(device)

    total_params = sum(p.numel() for p in model.parameters())
    print(f"\nTotal parameters: {total_params/1e6:.2f}M")

    print(f"\n{'='*80}")
    print("FUSION FEATURES:")
    print(f"{'='*80}")
    print("FROM BDH:")
    print("  ✓ Sparse encoding (D→N with ReLU)")
    print("  ✓ Hebbian state updates (synaptic plasticity)")
    print("  ✓ Multiplicative gating (x * y pathways)")
    print("  ✓ Quantized RoPE (hierarchical position)")
    print("  ✓ Monosemantic potential (interpretable synapses)")
    print("\nFROM EMULATIVE:")
    print("  ✓ Dynamic metric tensor (geometry responds to field)")
    print("  ✓ Local k-NN interaction (O(T·k) not O(T²))")
    print("  ✓ Adaptive evolution (field decides convergence)")
    print("  ✓ Energy conservation (stability constraint)")
    print("  ✓ Tokens as boundary conditions")
    print(f"{'='*80}\n")

    optimizer = torch.optim.AdamW(model.parameters(), lr=config['learning_rate'])

    # Training
    print("\n[3/5] Training...")
    print(f"{'Step':<8} {'Train':<10} {'Val':<10} {'Perp':<10} {'Steps':<8} {'Sparsity':<10} {'Time':<8}")
    print("-" * 80)

    model.train()

    for iter in range(config['max_iters']):
        t0 = time.time()

        # Evaluation
        if iter % config['eval_interval'] == 0 or iter == config['max_iters'] - 1:
            train_loss = estimate_loss(model, train_data, config['block_size'],
                                       config['batch_size'], device, 10)
            val_loss = estimate_loss(model, val_data, config['block_size'],
                                     config['batch_size'], device, 10)
            perplexity = np.exp(val_loss)

            # Get metrics from a sample batch
            xb, yb = get_batch(train_data, config['block_size'], config['batch_size'], device)
            _, _, steps, sparsity = model(xb, yb)

            print(f"{iter:<8} {train_loss:<10.4f} {val_loss:<10.4f} {perplexity:<10.2f} "
                  f"{steps:<8} {sparsity:<10.2%} {time.time()-t0:<8.3f}")

            # Generation
            if iter % (config['eval_interval'] * 2) == 0:
                print("\n--- Generated Sample (Field Condensation) ---")
                model.eval()
                context = torch.zeros((1, 1), dtype=torch.long, device=device)
                generated = model.generate(context, max_new_tokens=200, temperature=0.8, top_k=40)
                print(decode(generated[0].tolist()))
                print("-" * 80 + "\n")
                model.train()

        # Training step
        xb, yb = get_batch(train_data, config['block_size'], config['batch_size'], device)
        _, loss, _, _ = model(xb, yb)

        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()

    print("\n[4/5] Training complete!")

    # Final generation
    print("\n[5/5] Final generation...")
    print("=" * 80)
    model.eval()
    context = torch.zeros((1, 1), dtype=torch.long, device=device)
    generated = model.generate(context, max_new_tokens=500, temperature=0.8, top_k=40)
    print(decode(generated[0].tolist()))
    print("=" * 80)

    # Save
    torch.save({
        'model_state_dict': model.state_dict(),
        'config': config,
        'vocab': {'stoi': stoi, 'itos': itos}
    }, 'sghfm_fusion.pt')

    print("\n✓ Saved to: sghfm_fusion.pt")
    print("\nThis is the fusion. BDH + Emulative = SGHFM")
    print("Sparse. Geometric. Hebbian. Adaptive. Complete.")

    return model


if __name__ == '__main__':
    model = train_sghfm()