// The controller: fixed rules that decide what ANTERA may do on its own.
// "May stop, never start." This module can only ever return pause, task or notify actions.
// Starting and restarting exist only as human transitions, which the service checks separately.

export const CONTROLLER_VERSION = 'controller-2026.1';

export const STATES = Object.freeze(['draft', 'live', 'paused', 'ended']);

/** Who may move a campaign between states. `system` is the controller; `human` is a logged-in person. */
export const TRANSITIONS = Object.freeze({
  start:   { from: ['draft'], to: 'live', by: ['human'] },
  pause:   { from: ['live'], to: 'paused', by: ['system', 'human'] },
  restart: { from: ['paused'], to: 'live', by: ['human'] },
  end:     { from: ['draft', 'live', 'paused'], to: 'ended', by: ['human'] }
});

export function canTransition(action, state, actor) {
  const t = TRANSITIONS[action];
  return !!t && t.from.includes(state) && t.by.includes(actor);
}

/** The only action types the controller can produce. Tests assert nothing else ever comes out. */
export const ACTION_TYPES = Object.freeze(['pause', 'task', 'notify']);

/**
 * @param {object} input
 * @param {object} input.campaign   { id, state, owner_id }
 * @param {object[]} input.results  check results [{ id, status, code, params }]
 * @returns {{ health: 'HEALTHY'|'BROKEN'|'UNCLEAR', rule: string|null, actions: object[] }}
 */
export function decide({ campaign, results }) {
  const fails = results.filter(x => x.status === 'fail');
  const unknown = results.filter(x => x.status === 'unknown');
  const health = fails.length ? 'BROKEN' : unknown.length ? 'UNCLEAR' : 'HEALTHY';
  const cause = (fails[0] ?? unknown[0]) ?? null;
  const cite = cause && { check: cause.id, code: cause.code, params: cause.params };

  // C1 · A live campaign whose chain is observed to be broken: stop spending, tell the owner.
  if (campaign.state === 'live' && fails.length) {
    return {
      health, rule: 'C1_PAUSE_ON_BROKEN_CHAIN',
      actions: [
        { type: 'pause', rule: 'C1_PAUSE_ON_BROKEN_CHAIN', cause: cite },
        { type: 'task', rule: 'C1_PAUSE_ON_BROKEN_CHAIN', code: 'TASK_PAUSED', cause: cite },
        { type: 'notify', rule: 'C1_PAUSE_ON_BROKEN_CHAIN', event: 'campaign.paused', cause: cite }
      ]
    };
  }
  // C2 · Live, nothing observed broken, but something could not be verified: investigate, keep running.
  if (campaign.state === 'live' && unknown.length) {
    return { health, rule: 'C2_INVESTIGATE_UNCLEAR', actions: [{ type: 'task', rule: 'C2_INVESTIGATE_UNCLEAR', code: 'TASK_INVESTIGATE', cause: cite }] };
  }
  // C3 · Paused and the chain checks out again: a human may restart. ANTERA itself never does.
  if (campaign.state === 'paused' && !fails.length && !unknown.length) {
    return {
      health, rule: 'C3_READY_FOR_HUMAN_RESTART',
      actions: [
        { type: 'task', rule: 'C3_READY_FOR_HUMAN_RESTART', code: 'TASK_RESTART_POSSIBLE', cause: null },
        { type: 'notify', rule: 'C3_READY_FOR_HUMAN_RESTART', event: 'campaign.restart_possible', cause: null }
      ]
    };
  }
  return { health, rule: null, actions: [] };
}
