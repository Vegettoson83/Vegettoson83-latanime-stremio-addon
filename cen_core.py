# cen_core.py
# Foundational data structures for the Causal Entanglement Network (CEN)

import uuid
import math

class CausalNode:
    """
    Represents a single concept, encapsulating its state as a probability
    distribution (the "conceptual wave function") and its entanglements.
    """
    def __init__(self, name: str, initial_distribution: dict):
        if not isinstance(name, str) or not name:
            raise ValueError("Node name must be a non-empty string.")

        self.id = str(uuid.uuid4())
        self.name = name
        self.state_distribution = {}
        self.set_state_distribution(initial_distribution)

        # Format: {target_node_name: {"type": "causes", "weight": 0.95}}
        self.entanglements = {}

    def __repr__(self):
        # Display probabilities formatted to 3 decimal places
        dist_repr = {k: f"{v:.3f}" for k, v in self.state_distribution.items()}
        return f"CausalNode(name='{self.name}', distribution={dist_repr})"

    def _normalize(self):
        """Ensures the state distribution sums to 1.0."""
        total_prob = sum(self.state_distribution.values())
        if total_prob == 0:
            # Avoid division by zero; can happen if all states are zeroed out.
            # Re-initialize to a uniform distribution as a fallback.
            num_states = len(self.state_distribution)
            if num_states > 0:
                for state in self.state_distribution:
                    self.state_distribution[state] = 1.0 / num_states
            return

        for state, probability in self.state_distribution.items():
            self.state_distribution[state] = probability / total_prob

    def set_state_distribution(self, new_distribution: dict):
        """Sets the node's state to a new probability distribution."""
        if not isinstance(new_distribution, dict) or not new_distribution:
            raise ValueError("Initial distribution must be a non-empty dictionary.")
        if not math.isclose(sum(new_distribution.values()), 1.0, rel_tol=1e-5):
            raise ValueError("Probabilities in the distribution must sum to 1.0.")
        self.state_distribution = new_distribution

    def observe_state(self, observed_state: str):
        """
        Collapses the probability distribution based on a direct observation.
        The observed state's probability becomes 1.0, and all others become 0.0.
        """
        if observed_state not in self.state_distribution:
            raise ValueError(f"Cannot observe a state ('{observed_state}') that is not in the distribution.")

        print(f"Observation: '{self.name}' is now in state '{observed_state}'.")
        for state in self.state_distribution:
            self.state_distribution[state] = 1.0 if state == observed_state else 0.0

    def get_probability(self, state: str) -> float:
        """Returns the probability of a given state."""
        return self.state_distribution.get(state, 0.0)

class EntanglementGraph:
    """
    Manages a collection of CausalNodes, their entanglements, and the
    propagation of beliefs through the network.
    """
    def __init__(self):
        self.nodes = {}

    def __repr__(self):
        return f"EntanglementGraph(nodes={len(self.nodes)})"

    def get_node(self, name: str) -> CausalNode:
        """Retrieves a node by its name."""
        return self.nodes.get(name)

    def learn_concept(self, name: str, initial_distribution: dict) -> CausalNode:
        """
        Adds a new concept (CausalNode) to the graph.
        """
        if name in self.nodes:
            print(f"Concept '{name}' already exists.")
            return self.nodes[name]

        print(f"Learning new concept: '{name}'.")
        new_node = CausalNode(name, initial_distribution)
        self.nodes[name] = new_node
        return new_node

    def entangle(self, source_name: str, target_name: str, relationship_type: str, weight: float):
        """
        Establishes a directed, weighted causal link between two nodes.
        """
        if source_name not in self.nodes:
            raise ValueError(f"Source node '{source_name}' not found.")
        if target_name not in self.nodes:
            raise ValueError(f"Target node '{target_name}' not found.")

        print(f"Entangling '{source_name}' -> '{target_name}' (Type: {relationship_type}, Weight: {weight})")
        source_node = self.get_node(source_name)
        source_node.entanglements[target_name] = {
            "type": relationship_type,
            "weight": weight
        }

    def get_parents(self, node_name: str) -> dict:
        """Finds all parent nodes that have an entanglement pointing to the given node."""
        parents = {}
        for potential_parent_name, potential_parent_node in self.nodes.items():
            if node_name in potential_parent_node.entanglements:
                parents[potential_parent_name] = potential_parent_node.entanglements[node_name]
        return parents

    def propagate_update(self, source_name: str, max_depth=10, change_threshold=0.001):
        """
        Propagates a state change probabilistically using a layered, synchronous approach.
        This ensures that updates are based on a consistent state from the previous "layer".
        """
        if source_name not in self.nodes:
            print(f"Warning: Cannot propagate from non-existent node '{source_name}'.")
            return

        print(f"\n--- Initiating Layered Probabilistic Propagation from '{source_name}' ---")

        # A set of all nodes whose states have changed and whose children need re-evaluation.
        nodes_to_process = {source_name}

        for i in range(max_depth):
            if not nodes_to_process:
                print("Propagation stabilized. No more significant changes.")
                break

            print(f"\n--- Processing Layer {i+1} ({len(nodes_to_process)} node(s)) ---")
            next_layer_nodes = set()

            # Find all unique children of the currently active nodes
            nodes_to_recalculate = set()
            for name in nodes_to_process:
                node = self.get_node(name)
                for child_name in node.entanglements:
                    nodes_to_recalculate.add(child_name)

            if not nodes_to_recalculate:
                print("End of causal chain.")
                break

            for child_name in sorted(list(nodes_to_recalculate)): # Sort for deterministic order
                child_node = self.get_node(child_name)
                if not child_node: continue

                original_prob = child_node.get_probability("active")

                # --- Noisy-OR Evidence Combination ---
                # This logic is correct, but it must be applied synchronously.
                parents = self.get_parents(child_name)
                prob_not_activated = 1.0
                for parent_name, entanglement in parents.items():
                    parent_node = self.get_node(parent_name)
                    if entanglement["type"] == "causes":
                        prob_parent_active = parent_node.get_probability("active")
                        weight = entanglement["weight"]
                        prob_this_parent_fails = 1 - (prob_parent_active * weight)
                        prob_not_activated *= prob_this_parent_fails

                new_prob_active = 1 - prob_not_activated

                # Apply the update for the two-state system directly.
                # This corrects the previous normalization error.
                child_node.state_distribution["active"] = new_prob_active
                child_node.state_distribution["inactive"] = 1 - new_prob_active

                print(f"Recalculated '{child_name}' from {len(parents)} parent(s). P(active) changed from {original_prob:.3f} to {new_prob_active:.3f}")

                # If the change was significant, its children will be processed in the next layer.
                if abs(new_prob_active - original_prob) > change_threshold:
                    next_layer_nodes.add(child_name)

            nodes_to_process = next_layer_nodes

        if not nodes_to_process:
             print("\nPropagation complete.")
        else:
            print("\nMax propagation depth reached.")
