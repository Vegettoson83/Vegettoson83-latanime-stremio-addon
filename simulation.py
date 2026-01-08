# simulation.py
# A demonstration and verification test for the Causal Entanglement Network.

from cen_core import EntanglementGraph

def run_simulation():
    """
    Builds a simple causal graph, triggers a change, and observes the propagation.
    """
    print("--- Initializing Causal Entanglement Network Simulation ---")

    # 1. Instantiate the world model
    world = EntanglementGraph()
    print("\nStep 1: World model instantiated.")

    # 2. Learn core concepts
    print("\nStep 2: Learning core concepts...")
    world.learn_concept("Fire")
    world.learn_concept("Smoke")
    world.learn_concept("Heat")
    world.learn_concept("Smoke Detector")
    world.learn_concept("Alarm")
    world.learn_concept("Sprinkler System")

    # 3. Entangle concepts to form a causal web
    print("\nStep 3: Entangling concepts with causal relationships...")
    world.entangle("Fire", "Smoke", "causes", weight=0.98)
    world.entangle("Fire", "Heat", "causes", weight=0.99)
    world.entangle("Smoke", "Smoke Detector", "causes", weight=0.95)
    world.entangle("Heat", "Smoke Detector", "causes", weight=0.40) # Heat can also trigger some detectors
    world.entangle("Smoke Detector", "Alarm", "causes", weight=1.0)
    world.entangle("Alarm", "Sprinkler System", "causes", weight=0.90)

    print("\n--- Current State of the World Model ---")
    for node_name, node in world.nodes.items():
        print(node)

    # 4. Introduce an external event
    print("\n\nStep 4: Introducing an external event: A fire starts.")
    fire_node = world.get_node("Fire")
    fire_node.update_state({"status": "active"})

    # 5. Propagate the consequences of the event through the graph
    print("\nStep 5: Propagating the consequences through the causal web...")
    world.propagate_update("Fire")

    # 6. Verify the final state of the world
    print("\n\n--- Final State of the World Model after Propagation ---")
    for node_name, node in world.nodes.items():
        print(node)

    print("\n--- Verification ---")
    alarm_node = world.get_node("Alarm")
    sprinkler_node = world.get_node("Sprinkler System")

    if alarm_node.state.get("status") == "active":
        print("✅ VERIFIED: The Alarm was activated.")
    else:
        print("❌ FAILED: The Alarm was not activated.")

    if sprinkler_node.state.get("status") == "active":
        print("✅ VERIFIED: The Sprinkler System was activated.")
    else:
        print("❌ FAILED: The Sprinkler System was not activated.")

    if sprinkler_node.state.get("reason") == "Caused by Alarm":
         print("✅ VERIFIED: Sprinkler activation was correctly attributed to the Alarm.")
    else:
        print(f"❌ FAILED: Sprinkler activation attribution is incorrect. Reason: {sprinkler_node.state.get('reason')}")


if __name__ == "__main__":
    run_simulation()
