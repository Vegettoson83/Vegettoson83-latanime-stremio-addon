# simulation.py
# A demonstration and verification test for the Causal Entanglement Network's probabilistic engine.

from cen_core import EntanglementGraph

def run_simulation():
    """
    Builds a causal graph with prior probabilities, introduces an observation,
    and verifies the propagation of belief.
    """
    print("--- Initializing Probabilistic CEN Simulation ---")

    # 1. Instantiate the world model
    world = EntanglementGraph()
    print("\nStep 1: World model instantiated.")

    # 2. Define prior probabilities for a two-state system (active/inactive)
    # A low prior belief that anything is active without evidence.
    low_prior = {"active": 0.01, "inactive": 0.99}

    print("\nStep 2: Learning concepts with prior beliefs...")
    world.learn_concept("Fire", initial_distribution=low_prior.copy())
    world.learn_concept("Smoke", initial_distribution=low_prior.copy())
    world.learn_concept("Heat", initial_distribution=low_prior.copy())
    world.learn_concept("Smoke Detector", initial_distribution=low_prior.copy())
    world.learn_concept("Alarm", initial_distribution=low_prior.copy())
    world.learn_concept("Sprinkler System", initial_distribution=low_prior.copy())

    # 3. Entangle concepts to form a causal web
    print("\nStep 3: Entangling concepts...")
    world.entangle("Fire", "Smoke", "causes", weight=0.98)
    world.entangle("Fire", "Heat", "causes", weight=0.99)
    world.entangle("Smoke", "Smoke Detector", "causes", weight=0.95)
    world.entangle("Heat", "Smoke Detector", "causes", weight=0.40) # Weaker causal link
    world.entangle("Smoke Detector", "Alarm", "causes", weight=1.0) # A detector guarantees an alarm
    world.entangle("Alarm", "Sprinkler System", "causes", weight=0.90)

    print("\n--- Initial State of the World Model (Prior Beliefs) ---")
    for node_name, node in world.nodes.items():
        print(node)

    # 4. Introduce an external observation
    print("\n\nStep 4: Introducing an observation: 'Fire' is observed to be 'active'.")
    fire_node = world.get_node("Fire")
    fire_node.observe_state("active") # This collapses the wave function

    # 5. Propagate the consequences of the observation
    # This will update the belief distributions across the graph
    world.propagate_update("Fire")

    # 6. Verify the final state of the world (Posterior Beliefs)
    print("\n\n--- Final State of the World Model (Posterior Beliefs) ---")
    for node_name, node in world.nodes.items():
        print(node)

    print("\n--- Probabilistic Verification ---")
    alarm_node = world.get_node("Alarm")
    sprinkler_node = world.get_node("Sprinkler System")

    alarm_threshold = 0.95
    sprinkler_threshold = 0.85

    prob_alarm_active = alarm_node.get_probability("active")
    if prob_alarm_active > alarm_threshold:
        print(f"✅ VERIFIED: Belief in Alarm activation is high (P={prob_alarm_active:.3f} > {alarm_threshold}).")
    else:
        print(f"❌ FAILED: Belief in Alarm activation is too low (P={prob_alarm_active:.3f} <= {alarm_threshold}).")

    prob_sprinkler_active = sprinkler_node.get_probability("active")
    if prob_sprinkler_active > sprinkler_threshold:
        print(f"✅ VERIFIED: Belief in Sprinkler activation is high (P={prob_sprinkler_active:.3f} > {sprinkler_threshold}).")
    else:
        print(f"❌ FAILED: Belief in Sprinkler activation is too low (P={prob_sprinkler_active:.3f} <= {sprinkler_threshold}).")

if __name__ == "__main__":
    run_simulation()
