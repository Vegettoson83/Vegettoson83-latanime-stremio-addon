# cen_core.py
# Foundational data structures for the Causal Entanglement Network (CEN)

import uuid

class CausalNode:
    """
    Represents a single concept within the EntanglementGraph.
    It encapsulates the concept's state (its "conceptual wave function")
    and its relationships with other nodes.
    """
    def __init__(self, name: str, initial_state: dict = None):
        if not isinstance(name, str) or not name:
            raise ValueError("Node name must be a non-empty string.")

        self.id = str(uuid.uuid4())
        self.name = name

        # The "conceptual wave function": a probability distribution of possible states.
        # Example: {"state": "burning", "probability": 0.9}
        self.state = initial_state if initial_state is not None else {}

        # Stores relationships to other nodes.
        # Format: {target_node_id: {"type": "causes", "weight": 0.95}}
        self.entanglements = {}

    def __repr__(self):
        return f"CausalNode(name='{self.name}', state={self.state}, entanglements={len(self.entanglements)})"

    def update_state(self, new_state: dict, source_of_change: str = "external"):
        """Updates the node's state and prepares for propagation."""
        # A more sophisticated implementation would handle probabilistic updates.
        # For now, we'll do a simple overwrite.
        self.state = new_state
        print(f"State of '{self.name}' updated to {self.state} due to '{source_of_change}'.")

class EntanglementGraph:
    """
    Acts as the world model, managing a collection of CausalNodes
    and the rules for their interactions.
    """
    def __init__(self):
        # Stores all nodes in the graph, keyed by their unique name.
        self.nodes = {}

    def __repr__(self):
        return f"EntanglementGraph(nodes={len(self.nodes)})"

    def get_node(self, name: str) -> CausalNode:
        """Retrieves a node by its name."""
        return self.nodes.get(name)

    def node_exists(self, name: str) -> bool:
        """Checks if a node with a given name already exists."""
        return name in self.nodes

    def learn_concept(self, name: str, initial_state: dict = None) -> CausalNode:
        """
        Adds a new concept (CausalNode) to the graph.
        If the concept already exists, it returns the existing node.
        """
        if self.node_exists(name):
            print(f"Concept '{name}' already exists.")
            return self.get_node(name)

        print(f"Learning new concept: '{name}'.")
        new_node = CausalNode(name, initial_state)
        self.nodes[name] = new_node
        return new_node

    def entangle(self, source_name: str, target_name: str, relationship_type: str, weight: float):
        """
        Establishes a directed, weighted causal link between two nodes.
        Example: entangle("fire", "smoke", "causes", 0.95)
        """
        source_node = self.get_node(source_name)
        target_node = self.get_node(target_name)

        if not source_node:
            raise ValueError(f"Source node '{source_name}' not found in graph.")
        if not target_node:
            raise ValueError(f"Target node '{target_name}' not found in graph.")

        print(f"Entangling '{source_name}' -> '{target_name}' (Type: {relationship_type}, Weight: {weight})")
        source_node.entanglements[target_name] = {
            "type": relationship_type,
            "weight": weight
        }

    def propagate_update(self, source_name: str):
        """
        Propagates a state change from a source node to its entangled nodes.
        This is a simplified, deterministic implementation of causal propagation.
        """
        source_node = self.get_node(source_name)
        if not source_node:
            print(f"Warning: Cannot propagate from non-existent node '{source_name}'.")
            return

        print(f"--- Propagating updates from '{source_name}' ---")
        for target_name, entanglement in source_node.entanglements.items():
            target_node = self.get_node(target_name)
            if not target_node:
                continue

            relationship_type = entanglement["type"]
            weight = entanglement["weight"]

            # This is a highly simplified logic model. A real CEN would use
            # probabilistic updates based on the nature of the states.
            if relationship_type == "causes":
                # If the source has a status, cause a related status in the target.
                if "status" in source_node.state and source_node.state["status"] == "active":
                    new_target_state = {
                        "status": "active",
                        "reason": f"Caused by {source_name}"
                    }
                    target_node.update_state(new_target_state, source_of_change=f"propagation from {source_name}")
                    # Recursively propagate from the newly updated node
                    self.propagate_update(target_name)
