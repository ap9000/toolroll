/** Shared conversations consume the existing saved status stream. No task
 * scans, model calls, or execution retries happen in this delivery layer. */
import type { Store } from './store.js';
import { TeamLeads } from './team-leads.js';
import type { TeamActor } from './team-contract.js';
import { ASSIGNMENT_STATUS_ACTION, LEAD_WAKE_STATES, parseAssignmentStatusEvent } from './assignment-status.js';

export const teamUpdateCursor = (conversation: string) => `team-updates:${conversation}`;
export function startTeamUpdates(store:Store,conversation:string,now:Date):void {
  // Enabling updates starts here. Past events remain available in task history.
  const latest=Number(store.handle.prepare('SELECT COALESCE(MAX(id),0) AS n FROM action_ledger').get()?.['n']??0);
  store.setServiceCursor(teamUpdateCursor(conversation),latest,now);
}

export function deliverTeamUpdates(store:Store,domain:TeamLeads,authorized:(actor:TeamActor,conversation:string)=>boolean,now:Date):number {
  const destinations=new Map<string,ReturnType<TeamLeads['followGrants']>[number]>();
  for(const grant of domain.followGrants())if(!destinations.has(grant.conversation.id)&&authorized(grant.actor,grant.conversation.id))destinations.set(grant.conversation.id,grant);
  let queued=0;
  for(const [conversationId,grant] of destinations){
    store.transact(()=>{
      // Selection happened before obtaining the write lock. Reprove the
      // observer and its paid allowance at the cursor/admission boundary.
      const current=domain.followGrants().find(one=>one.conversation.id===conversationId&&one.actor.name===grant.actor.name&&one.actor.generation===grant.actor.generation);
      if(!current||!authorized(current.actor,conversationId))return;
      const after=store.serviceCursor(teamUpdateCursor(conversationId));
      const rows=store.handle.prepare(`SELECT a.id,a.outcome,a.task_id,a.repo FROM action_ledger a
        JOIN task_ref t ON t.backend='built-in' AND t.external_id=a.task_id AND t.repo=a.repo AND t.revision_of IS NULL
        JOIN team_task_owner o ON o.task_ref=t.id AND o.lead=? AND o.conversation=?
        WHERE a.action=? AND a.source='work' AND a.actor=? AND a.id>?
          AND a.repo IN (SELECT value FROM json_each(?))
        ORDER BY a.id LIMIT 50`).all(current.lead.id,conversationId,ASSIGNMENT_STATUS_ACTION,`lead:${current.lead.id}`,after,JSON.stringify(current.conversation.projects));
      if(!rows.length)return;
      const changes:string[]=[];
      let through=after;
      for(const row of rows){
        const event=parseAssignmentStatusEvent(String(row['outcome']));
        // Keep an unreadable row pending instead of silently losing delivery.
        if(!event||event.assignment.rootId!==row['task_id']||event.assignment.owner?.kind!=='lead'||event.assignment.owner.id!==current.lead.id)break;
        through=Number(row['id']);
        if(!LEAD_WAKE_STATES.includes(event.assignment.state))continue;
        changes.push(`${event.assignment.rootId}: ${event.assignment.title.slice(0,100)} — ${event.assignment.state}. ${event.assignment.detail.slice(0,180)}`);
        if(changes.length===4)break;
      }
      if(changes.length){
        const text=`Automatic update authorized by ${grant.actor.name}. Read these saved task changes and report what needs attention. Do not rerun tasks or repeat checks to recover delivery.\n${changes.join('\n')}`;
        const result=domain.execute(grant.actor,{operation:'send',args:{conversationId,requestId:`team-update:${conversationId}:${through}`,text}},now);
        if(!result.ok)return;
        queued++;
      }
      if(through>after)store.setServiceCursor(teamUpdateCursor(conversationId),through,now);
    });
  }
  return queued;
}
