# simulation.py
# A demonstration and verification test for the CEN's neuro-symbolic verifier.

from cen_core import EntanglementGraph, SymbolicRule

def run_simulation():
    """
    Builds a causal graph, adds a logical rule, and verifies that the
    propagation engine pivots when a probabilistic update violates the rule.
    """
    print("--- Initializing Neuro-Symbolic CEN Simulation ---")

    world = EntanglementGraph()
    low_prior = {"active": 0.01, "inactive": 0.99}

    print("\nStep 1: Learning concepts...")
    world.learn_concept("Manual Override", initial_distribution=low_prior.copy())
    world.learn_concept("Fire", initial_distribution=low_prior.copy())
    world.learn_concept("Alarm", initial_distribution=low_prior.copy())

    print("\nStep 2: Entangling concepts...")
    world.entangle("Fire", "Alarm", "causes", weight=0.95)

    # --- The Symbolic Layer ---
    print("\nStep 3: Defining and adding a symbolic rule...")
    # This rule represents a hard constraint: The alarm CANNOT be active if
    # the manual override is also active. This is a common safety feature.
    rule = SymbolicRule(
        description="Alarm cannot be active if Manual Override is active",
        condition_func=lambda graph: not (
            graph.get_node("Alarm").get_probability("active") > 0.5 and
            graph.get_node("Manual Override").get_probability("active") > 0.5
        )
    )
    world.add_rule(rule)

    print("\n--- Initial State of the World Model ---")
    for node in world.nodes.values(): print(node)

    # --- Scenario ---
    print("\n\nStep 4: Scenario setup...")
    print("Observation 1: A 'Manual Override' has been activated for a fire drill.")
    world.get_node("Manual Override").observe_state("active")

    print("Observation 2: A 'Fire' is detected (probabilistically, this should trigger the alarm).")
    world.get_node("Fire").observe_state("active")

    # --- Propagation and Verification ---
    # The propagation engine will attempt to activate the Alarm due to the Fire.
    # However, the Formal Verifier should catch that this violates the symbolic rule
    # because the Manual Override is active, and thus reject the update.
    world.propagate_update("Fire")

    print("\n\n--- Final State of the World Model ---")
    for node in world.nodes.values(): print(node)

    print("\n--- Neuro-Symbolic Verification ---")
    alarm_node = world.get_node("Alarm")
    final_alarm_prob = alarm_node.get_probability("active")

    # The crucial test: The alarm's probability should remain low, as the
    # probabilistic update should have been blocked by the symbolic rule.
    if final_alarm_prob < 0.1:
        print(f"✅ VERIFIED: The Alarm's activation was correctly blocked by the symbolic rule. (Final P(active)={final_alarm_prob:.3f})")
    else:
        print(f"❌ FAILED: The symbolic rule was bypassed. The Alarm was activated with P={final_alarm_prob:.3f}.")

if __name__ == "__main__":
    run_simulation()
