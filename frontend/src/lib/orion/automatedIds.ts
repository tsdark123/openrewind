// =============================================================================
// automatedIds — Frontend-only tracker for orders/positions placed by Orion.
//
// Rationale: the automation flag exists purely so we can (a) filter agent
// trades out of the persisted journal and (b) style their chart markers
// differently. The C++ matching engine has no legitimate reason to care —
// its job is honest fill simulation. Piping a flag through Order/Position/
// events/session would be a lot of surface area for zero engine value.
//
// So instead: when the Automation Driver places an order, it records the
// returned order_id here. When `order_filled` and `position_closed` events
// come back over the WebSocket, the hook consults this set and stamps
// `is_automated: true` on the payload before dispatching to the reducer.
//
// The set is intentionally a module singleton — it's a cross-cutting side
// effect, not visual state, and it must survive React re-renders and
// symbol/date switches without being reset.
// =============================================================================

const automatedOrderIds = new Set<number>();
const automatedPositionIds = new Set<number>();
let automationActive = false;

/**
 * Mark an order id as automated at the moment the WS `place_order` command
 * is sent. Because engine-assigned order ids arrive in the `order_accepted`
 * reply we may not know the id yet; callers should register once the id is
 * known (typically in the `order_filled` bridge — see also the Controller).
 */
export function markOrderAutomated(orderId: number): void {
  automatedOrderIds.add(orderId);
}

/** Mirror for position_closed events — position id == order id in this engine. */
export function markPositionAutomated(positionId: number): void {
  automatedPositionIds.add(positionId);
}

export function setAutomationActive(active: boolean): void {
  automationActive = active;
}

export function isAutomationActive(): boolean {
  return automationActive;
}

export function isOrderAutomated(orderId: number): boolean {
  return automationActive || automatedOrderIds.has(orderId);
}

export function isPositionAutomated(positionId: number): boolean {
  // The engine reuses order_id as position_id on fill, so a hit in either
  // set counts as automated.
  return automationActive || automatedPositionIds.has(positionId) || automatedOrderIds.has(positionId);
}

/** Clear the trackers — called by the controller when a task run ends. */
export function clearAutomatedIds(): void {
  automatedOrderIds.clear();
  automatedPositionIds.clear();
  automationActive = false;
}
