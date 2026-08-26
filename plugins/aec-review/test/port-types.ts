/**
 * Output port-type conformance for the aec-review suite.
 *
 * The check itself is `isValueOfType`, the engine's own (ARCHITECTURE §6.1 /
 * ADR-0006), re-exported from `@archspace/node-sdk` so a plugin can reach it
 * without declaring `@archspace/types` — which a plugin outside this repo could
 * not do at all. An earlier version of this file transcribed the three branches
 * this plugin's ports needed, because the SDK did not expose it yet; that copy
 * is gone, and it should stay gone. A hand-written type checker in a test suite
 * silently stops agreeing with the engine, and this is the suite whose whole
 * job is to prove the plugin boundary holds.
 *
 * What remains here is the part `isValueOfType` cannot answer: a declared
 * output port that the node never emitted at all. That is not a type mismatch —
 * there is no value to judge — but it is the same defect from a caller's point
 * of view, so both are collected into one list of readable problems. Returning
 * the mismatches instead of asserting keeps this module assertion-free and lets
 * the failing test name the port.
 */
import { isValueOfType, type NodeModule, type Outputs } from '@archspace/node-sdk';

/**
 * Every output that is missing or does not inhabit its declared port type.
 * Empty means the node's outputs match the contract its manifest advertises.
 */
export function portTypeMismatches(mod: NodeModule<never> | NodeModule<unknown>, outputs: Outputs): string[] {
  const problems: string[] = [];
  for (const port of mod.manifest.outputs) {
    if (!(port.id in outputs)) {
      problems.push(`${mod.manifest.type}.${port.id}: declared output was never emitted`);
    } else if (!isValueOfType(outputs[port.id], port.type)) {
      problems.push(`${mod.manifest.type}.${port.id}: does not inhabit ${port.type}`);
    }
  }
  return problems;
}
