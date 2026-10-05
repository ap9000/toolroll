import { createHash, randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import { scanForSecrets } from './evidence.js';
import { ceilingDigestOf } from './principal.js';
import { normalizeProjectAccess, projectAccessAllows, readProjectAccess } from './project-access.js';
import type { TeamActor, TeamConversation, TeamLead, TeamMessage, TeamRequest, TeamResponse, TeamRole, TeamSnapshot } from './team-contract.js';

export type TeamAccess = { conversation: TeamConversation; lead: TeamLead; role: TeamRole };
export type TeamClaim = {
  conversationId: string; leadId: string; threadId: number; messageId: number; messageRevision: number;
  generation: number; runner: string; actor: TeamActor; text: string; projects: string[];
  instructions: string; requestId: string;
};
type Row = Record<string, unknown>;
class TeamRefusal extends Error { constructor(readonly code: string, message: string) { super(message); } }
function refuse(code: string, message: string): never { throw new TeamRefusal(code, message); }
function str(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || /[\x00]/.test(value)) refuse('invalid', `${label} is required (up to ${max} characters).`);
  return value.trim();
}
function messageText(value: unknown): string {
  const text = str(value, 'Message', 2000);
  if (scanForSecrets(text).length > 0) refuse('secret-in-message', 'Remove credentials from the message before sending it.');
  return text;
}
function integer(value: unknown, label = 'Revision'): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) refuse('invalid', `${label} must be a nonnegative integer.`);
  return Number(value);
}
function rank(role: unknown): number { return role === 'manager' ? 2 : role === 'contributor' ? 1 : 0; }
function role(value: unknown): TeamRole {
  if (value !== 'viewer' && value !== 'contributor' && value !== 'manager') refuse('invalid', 'Choose Viewer, Contributor or Manager.');
  return value;
}
/** A failed turn's words for its message: none when the turn said why in the thread itself (it stopped at its deadline). */
function savedFailure(reason: unknown): string | null {
  return reason === 'timeout' || reason === 'crashed' ? null : String(reason ?? 'The saved turn failed.');
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k,stable(v)]));
  return value;
}

/** One central database owns audiences and queued turns. No model or provider calls here. */
export class TeamLeads {
  constructor(readonly store: Store, readonly enrolled: () => readonly string[]) {}
  private get db() { return this.store.handle; }
  private account(actor: TeamActor) {
    const account = this.store.accountOf(actor.name);
    if (account === null || account.revokedAt !== null || account.generation !== actor.generation) refuse('signed-out', 'Sign in again to use this conversation.');
    return account;
  }
  private leadRow(id: string): Row {
    const row = this.db.prepare('SELECT * FROM team_lead WHERE id=?').get(id);
    if (!row) refuse('not-found', 'Lead not available.');
    return row;
  }
  private leadProjects(id: string): string[] { return this.db.prepare('SELECT project FROM team_lead_project WHERE lead=? ORDER BY project').all(id).map(r => String(r['project'])); }
  private leadOf(row: Row): TeamLead {
    return { id:String(row['id']), name:String(row['name']), instructions:String(row['instructions']), projects:this.leadProjects(String(row['id'])), revision:Number(row['revision']), status:row['status'] === 'paused' ? 'paused' : 'active', createdBy:String(row['created_by']) };
  }
  private leadAccess(actor: TeamActor, id: string, required: TeamRole = 'viewer'): { lead:TeamLead; role:TeamRole; member:Row } {
    const account = this.account(actor), lead = this.leadOf(this.leadRow(id));
    const member = this.db.prepare('SELECT * FROM team_lead_member WHERE lead=? AND account=? AND active=1').get(id,actor.name);
    if (!member || rank(member['role']) < rank(required)) refuse('forbidden', 'You do not have access to this lead.');
    if (lead.projects.some(p => !projectAccessAllows(account.projects,p) || !this.enrolled().includes(p))) refuse('forbidden', 'Managing this lead requires access to all of its projects.');
    if (required !== 'viewer' && account.role !== 'approver') refuse('read-only', 'Your account can read shared conversations. An operator account is needed to send requests.');
    return { lead,role:String(member['role']) as TeamRole,member };
  }
  private projects(actor: TeamActor, value: unknown, allowed?: readonly string[]): string[] {
    let projects:string[]|null;
    try { projects=normalizeProjectAccess(value); } catch { refuse('invalid','Choose valid project paths.'); }
    if (projects === null || projects.length === 0) refuse('invalid', 'Choose at least one project.');
    const current = this.account(actor), enrolled = this.enrolled();
    if (projects.some(p => !enrolled.includes(p) || !projectAccessAllows(current.projects,p) || (allowed !== undefined && !allowed.includes(p)))) refuse('forbidden', 'Choose projects you can access within this lead.');
    return projects;
  }
  private conversationOf(row: Row, actor:TeamActor):TeamConversation {
    const followRow = this.db.prepare('SELECT * FROM team_follow WHERE conversation=? AND account=? AND generation=? AND enabled=1').get(String(row['id']),actor.name,actor.generation);
    const revisions = this.memberRevisions(String(row['id']), actor.name);
    const follow = followRow !== undefined && revisions !== null && revisions.lead === Number(followRow['lead_member_revision']) && revisions.participant === Number(followRow['participant_revision']);
    return { id:String(row['id']),leadId:String(row['lead']),title:String(row['title']),visibility:row['visibility'] === 'team' ? 'team':'private',projects:[...(readProjectAccess(row['projects_json']) ?? [])],revision:Number(row['revision']),threadId:Number(row['thread']),createdBy:String(row['created_by']),follow };
  }
  access(actor:TeamActor,conversationId:string,required:TeamRole='viewer'):TeamAccess {
    const account=this.account(actor);
    const row=this.db.prepare('SELECT * FROM team_conversation WHERE id=?').get(conversationId);
    if (!row || (row['visibility']==='private' && row['created_by']!==actor.name)) refuse('not-found','Conversation not available.');
    const {lead,role:leadRole}=this.leadAccess(actor,String(row['lead']),required);
    const member=this.db.prepare('SELECT * FROM team_participant WHERE conversation=? AND account=? AND active=1').get(conversationId,actor.name);
    const conversation=this.conversationOf(row,actor);
    if (!member || rank(member['role'])<rank(required) || conversation.projects.length===0 || conversation.projects.some(p=>!lead.projects.includes(p)||!this.enrolled().includes(p)||!projectAccessAllows(account.projects,p))) refuse('forbidden','You no longer have access to this conversation.');
    return {conversation,lead,role:rank(leadRole)<rank(member['role'])?leadRole:String(member['role']) as TeamRole};
  }
  private event(lead:string,conversation:string|null,kind:string,actor:string,now:Date):void {
    this.db.prepare('INSERT INTO team_event(lead,conversation,kind,actor,created_at) VALUES(?,?,?,?,?)').run(lead,conversation,kind,actor,now.toISOString());
  }
  /** Permission recheck and a small indexed cursor query; it never rebuilds chat history. */
  cursor(actor:TeamActor,conversationId?:string):number|null {
    try {
      this.account(actor);
      if (conversationId) { const {lead}=this.access(actor,conversationId); return Number(this.db.prepare('SELECT COALESCE(MAX(id),0) AS n FROM team_event WHERE (conversation=? OR (conversation IS NULL AND lead=?))').get(conversationId,lead.id)?.['n']??0); }
      return Number(this.db.prepare(`SELECT COALESCE(MAX(e.id),0) AS n FROM team_event e JOIN team_lead_member m ON m.lead=e.lead AND m.account=? AND m.active=1
        WHERE e.conversation IS NULL OR EXISTS(SELECT 1 FROM team_participant p JOIN team_conversation c ON c.id=p.conversation WHERE p.conversation=e.conversation AND p.account=? AND p.active=1 AND (c.visibility='team' OR c.created_by=?))`).get(actor.name,actor.name,actor.name)?.['n']??0);
    } catch (e) { if (e instanceof TeamRefusal) return null; throw e; }
  }
  snapshot(actor:TeamActor,conversationId?:string,leadId?:string):TeamSnapshot {
    const account=this.account(actor);
    const leads=this.db.prepare('SELECT l.* FROM team_lead l JOIN team_lead_member m ON m.lead=l.id WHERE m.account=? AND m.active=1 ORDER BY l.created_at,l.id').all(actor.name).map(r=>this.leadOf(r)).filter(l=>l.projects.every(p=>projectAccessAllows(account.projects,p)&&this.enrolled().includes(p)));
    const conversations:TeamConversation[]=[];
    for (const r of this.db.prepare(`SELECT c.* FROM team_conversation c JOIN team_participant p ON p.conversation=c.id WHERE p.account=? AND p.active=1 ORDER BY c.created_at DESC,c.id`).all(actor.name)) {
      try { const a=this.access(actor,String(r['id'])); if (!leadId||a.lead.id===leadId) conversations.push(a.conversation); } catch(e) { if (!(e instanceof TeamRefusal)) throw e; }
    }
    const selected=conversationId?this.access(actor,conversationId).conversation:conversations[0]??null;
    const access=selected?this.access(actor,selected.id):null;
    const messages:TeamMessage[]=selected?this.db.prepare(`SELECT * FROM (SELECT m.*,q.author,q.request_id,q.status,q.revision AS message_revision,q.error FROM mate_message m LEFT JOIN team_message q ON q.message=m.id WHERE m.thread=? ORDER BY m.id DESC LIMIT 201) ORDER BY id`).all(selected.threadId).map(r=>({id:Number(r['id']),author:r['role']==='assistant'?access!.lead.name:String(r['author']??selected.createdBy),role:String(r['role']) as TeamMessage['role'],text:String(r['text']),status:(r['status']??'answered') as TeamMessage['status'],revision:Number(r['message_revision']??1),createdAt:String(r['created_at']),requestId:r['request_id']==null?null:String(r['request_id']),turnId:r['turn']==null?null:Number(r['turn']),error:r['error']==null?null:String(r['error'])})):[];
    const participants=selected?this.db.prepare('SELECT account,role,active FROM team_participant WHERE conversation=? ORDER BY account').all(selected.id).map(r=>({account:String(r['account']),role:String(r['role']) as TeamRole,active:Number(r['active'])===1})):[];
    const canManage=account.role==='approver'&&(access?access.role==='manager':leadId?this.leadAccess(actor,leadId).role==='manager':false);
    return {leads,conversations,selected,participants,messages:messages.slice(-200),canManage,canCreateLead:account.role==='approver'&&this.enrolled().some(p=>projectAccessAllows(account.projects,p)),canSend:account.role==='approver'&&access!==null&&rank(access.role)>=1&&access.lead.status==='active',cursor:this.cursor(actor,selected?.id)??0,truncated:messages.length>200,projects:this.enrolled().filter(p=>projectAccessAllows(account.projects,p)),accounts:canManage?this.store.accountFacts().filter(a=>a.revokedAt===null&&(selected?.projects??[]).every(p=>projectAccessAllows(a.projects,p))).map(a=>a.name):[]};
  }
  execute(actor:TeamActor,request:TeamRequest,now=new Date()):TeamResponse {
    try {
      const result=this.store.transact(()=>{
        this.account(actor);
        const requestId=request.args['requestId'];
        const key=requestId===undefined?null:str(requestId,'Request ID',128);
        const digest=hash(stable(request));
        if(key){ const seen=this.db.prepare('SELECT payload_hash,response_json FROM team_request WHERE account=? AND generation=? AND request_id=?').get(actor.name,actor.generation,key); if(seen){if(seen['payload_hash']!==digest)refuse('request-conflict','This request ID was already used for different content.');return JSON.parse(String(seen['response_json'])) as TeamResponse;} }
        const response=this.perform(actor,request,now);
        if(key)this.db.prepare('INSERT INTO team_request(account,generation,request_id,payload_hash,response_json) VALUES(?,?,?,?,?)').run(actor.name,actor.generation,key,digest,JSON.stringify(response));
        return response;
      });
      if(request.operation==='read')return result; // Personal read receipts never rebuild the shared workspace.
      const conversationId=typeof request.args['conversationId']==='string'?request.args['conversationId']:undefined;
      const leadId=typeof request.args['leadId']==='string'?request.args['leadId']:undefined;
      // A membership operation may deliberately remove the caller; its receipt still stands.
      try { return {...result,snapshot:this.snapshot(actor,conversationId,leadId)}; } catch(e){if(e instanceof TeamRefusal)return result;throw e;}
    }catch(e){if(e instanceof TeamRefusal)return {version:1,ok:false,code:e.code,message:e.message};throw e;}
  }
  private perform(actor:TeamActor,request:TeamRequest,now:Date):TeamResponse {
    const a=request.args;
    const ok=(message:string,result?:unknown):TeamResponse=>({version:1,ok:true,code:'ok',message,...(result===undefined?{}:{result})});
    if(request.operation==='list'||request.operation==='show'){if(typeof a['conversationId']==='string')this.access(actor,a['conversationId']);if(typeof a['leadId']==='string')this.leadAccess(actor,a['leadId']);return ok('Conversation loaded.');}
    if(request.operation==='create-lead'){
      if(this.account(actor).role!=='approver')refuse('read-only','An operator account is needed to create a lead.');
      const projects=this.projects(actor,a['projects']),id=randomUUID(),name=str(a['name'],'Lead name',120),instructions=typeof a['instructions']==='string'?a['instructions']:'';
      if(instructions.length>12000)refuse('invalid','Lead instructions must be at most 12,000 characters.');
      if(scanForSecrets(instructions).length>0)refuse('secret-in-context','Remove credentials from the lead instructions.');
      this.db.prepare('INSERT INTO team_lead(id,name,instructions,status,created_by,created_at) VALUES(?,?,?,?,?,?)').run(id,name,instructions,'active',actor.name,now.toISOString());
      for(const p of projects)this.db.prepare('INSERT INTO team_lead_project(lead,project) VALUES(?,?)').run(id,p);
      this.db.prepare("INSERT INTO team_lead_member(lead,account,role) VALUES(?,?,'manager')").run(id,actor.name);
      this.event(id,null,'lead-created',actor.name,now);return ok('Lead created.',{leadId:id});
    }
    if(request.operation==='update-lead'){
      const id=str(a['leadId'],'Lead'),{lead}=this.leadAccess(actor,id,'manager');
      if(lead.revision!==integer(a['expectedRevision']))refuse('conflict','This lead changed. Reload before editing.');
      const name=a['name']===undefined?lead.name:str(a['name'],'Lead name',120),instructions=a['instructions']===undefined?lead.instructions:String(a['instructions']);
      const status=a['status']??lead.status;if(status!=='active'&&status!=='paused')refuse('invalid','Choose Active or Paused.');
      if(instructions.length>12000)refuse('invalid','Lead instructions must be at most 12,000 characters.');
      if(scanForSecrets(instructions).length>0)refuse('secret-in-context','Remove credentials from the lead instructions.');
      if(a['projects']!==undefined)refuse('fixed-scope','Create a new lead for a different project scope. Existing conversation history keeps its original scope.');
      this.db.prepare('UPDATE team_lead SET name=?,instructions=?,status=?,revision=revision+1 WHERE id=?').run(name,instructions,status,id);
      this.event(id,null,'lead-updated',actor.name,now);return ok('Lead updated.',{leadId:id});
    }
    if(request.operation==='create-conversation'){
      const leadId=str(a['leadId'],'Lead'),{lead}=this.leadAccess(actor,leadId,'contributor');
      const projects=this.projects(actor,a['projects'],lead.projects),id=randomUUID(),title=str(a['title'],'Conversation title',160),visibility=a['visibility'];
      if(visibility!=='private'&&visibility!=='team')refuse('invalid','Choose Private or Team.');
      const thread=this.store.openTeamMateThread(actor.name,ceilingDigestOf(projects),now);
      this.db.prepare('INSERT INTO team_conversation(id,lead,title,visibility,projects_json,thread,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,leadId,title,visibility,JSON.stringify(projects),thread.id,actor.name,now.toISOString());
      this.db.prepare("INSERT INTO team_participant(conversation,account,role) VALUES(?,?,'manager')").run(id,actor.name);
      this.event(leadId,id,'conversation-created',actor.name,now);return ok('Conversation created.',{conversationId:id,threadId:thread.id});
    }
    if(request.operation==='member'){
      const conversationId=typeof a['conversationId']==='string'?a['conversationId']:null;
      const access=conversationId?this.access(actor,conversationId,'manager'):null;
      const leadId=access?.lead.id??str(a['leadId'],'Lead'),{lead}=this.leadAccess(actor,leadId,'manager');
      const expected=integer(a['expectedRevision']);if(expected!==(access?.conversation.revision??lead.revision))refuse('conflict','Membership changed. Reload before editing.');
      if(access?.conversation.visibility==='private')refuse('private','A private conversation cannot add people. Create a fresh team conversation.');
      if(a['active']!==undefined&&typeof a['active']!=='boolean')refuse('invalid','Choose whether this membership is active.');
      const account=str(a['account'],'Account'),memberRole=role(a['role']),active=a['active']!==false,target=this.store.accountOf(account),projects=access?.conversation.projects??lead.projects;
      if(!target||(active&&(target.revokedAt!==null||projects.some(p=>!projectAccessAllows(target.projects,p)))))refuse('forbidden','This person needs access to every project in the conversation.');
      if(active&&memberRole!=='viewer'&&target.role!=='approver')refuse('read-only','Viewer accounts can join with the Viewer role.');
      if(active&&conversationId){
        const lm=this.db.prepare('SELECT role FROM team_lead_member WHERE lead=? AND account=? AND active=1').get(leadId,account);
        if(a['joinLead']===true){
          if(integer(a['expectedLeadRevision'])!==lead.revision)refuse('conflict','Lead membership changed. Reload before adding this person.');
          if(lead.projects.some(p=>!projectAccessAllows(target.projects,p)))refuse('forbidden','This person needs access to every project in the lead.');
          if(!lm||rank(lm['role'])<rank(memberRole)){
            this.db.prepare('INSERT INTO team_lead_member(lead,account,role,active) VALUES(?,?,?,1) ON CONFLICT(lead,account) DO UPDATE SET role=excluded.role,active=1,revision=team_lead_member.revision+1').run(leadId,account,memberRole);
            this.db.prepare('UPDATE team_lead SET revision=revision+1 WHERE id=?').run(leadId);
            this.revokeMemberSessions(leadId,null,account,now);
            this.event(leadId,null,'membership-changed',actor.name,now);
          }
        }else if(!lm||rank(lm['role'])<rank(memberRole))refuse('lead-membership','Add this person to the lead with the same role first.');
      }
      const table=conversationId?'team_participant':'team_lead_member',column=conversationId?'conversation':'lead',id=conversationId??leadId;
      const old=this.db.prepare(`SELECT role,active FROM ${table} WHERE ${column}=? AND account=?`).get(id,account);
      if(old?.['role']==='manager'&&Number(old['active'])===1&&(!active||memberRole!=='manager')&&!this.db.prepare(`SELECT 1 FROM ${table} WHERE ${column}=? AND account<>? AND role='manager' AND active=1`).get(id,account))refuse('last-manager','Keep at least one manager.');
      this.db.prepare(`INSERT INTO ${table}(${column},account,role,active) VALUES(?,?,?,?) ON CONFLICT(${column},account) DO UPDATE SET role=excluded.role,active=excluded.active,revision=${table}.revision+1`).run(id,account,memberRole,active?1:0);
      this.db.prepare(`UPDATE ${conversationId?'team_conversation':'team_lead'} SET revision=revision+1 WHERE id=?`).run(id);
      this.revokeMemberSessions(leadId,conversationId,account,now);
      this.event(leadId,conversationId,'membership-changed',actor.name,now);return ok(active?'Membership updated.':'Access removed.');
    }
    if(request.operation==='transfer')return this.transfer(actor,a,now);
    const conversationId=str(a['conversationId'],'Conversation');
    const {conversation,lead,role:memberRole}=this.access(actor,conversationId,request.operation==='read'?'viewer':'contributor');
    if(request.operation==='send'){
      if(lead.status!=='active')refuse('paused','This lead is paused. Ask a manager to resume it.');
      const text=messageText(a['text']),requestId=str(a['requestId'],'Request ID',128),digest=hash({conversationId,text});
      const seen=this.db.prepare('SELECT * FROM team_message WHERE conversation=? AND author=? AND request_id=?').get(conversationId,actor.name,requestId);
      if(seen){if(seen['payload_hash']!==digest)refuse('request-conflict','This request ID already saved a different message.');return ok('Message already saved.',{messageId:Number(seen['message']),status:String(seen['status'])});}
      const revisions=this.memberRevisions(conversationId,actor.name)!;
      const messageId=this.store.appendMateMessage({thread:conversation.threadId,turn:null,role:'operator',text},now);
      this.db.prepare("INSERT INTO team_message(message,conversation,author,author_generation,lead_member_revision,participant_revision,request_id,payload_hash,status) VALUES(?,?,?,?,?,?,?,?,'queued')").run(messageId,conversationId,actor.name,actor.generation,revisions.lead,revisions.participant,requestId,digest);
      this.event(lead.id,conversationId,'message-queued',actor.name,now);return ok('Message saved.',{messageId,status:'queued'});
    }
    if(request.operation==='read'){
      const id=integer(a['messageId'],'Message');if(id>0&&!this.db.prepare('SELECT 1 FROM mate_message WHERE id=? AND thread=?').get(id,conversation.threadId))refuse('not-found','Message not available.');
      this.db.prepare('INSERT INTO team_read(conversation,account,message) VALUES(?,?,?) ON CONFLICT(conversation,account) DO UPDATE SET message=MAX(team_read.message,excluded.message)').run(conversationId,actor.name,id);return ok('Read position saved.');
    }
    if(request.operation==='follow'){
      if(typeof a['enabled']!=='boolean')refuse('invalid','Choose whether to follow this conversation.');
      const revisions=this.memberRevisions(conversationId,actor.name)!;
      this.db.prepare('INSERT INTO team_follow(conversation,account,generation,lead_member_revision,participant_revision,enabled) VALUES(?,?,?,?,?,?) ON CONFLICT(conversation,account) DO UPDATE SET generation=excluded.generation,lead_member_revision=excluded.lead_member_revision,participant_revision=excluded.participant_revision,enabled=excluded.enabled').run(conversationId,actor.name,actor.generation,revisions.lead,revisions.participant,a['enabled']?1:0);
      this.event(lead.id,conversationId,'follow-changed',actor.name,now);return ok(a['enabled']?'Updates enabled.':'Updates paused.');
    }
    const id=integer(a['messageId'],'Message'),message=this.db.prepare('SELECT * FROM team_message WHERE message=? AND conversation=?').get(id,conversationId);
    if(!message)refuse('not-found','Message not available.');
    if(request.operation==='stop'){
      if(message['author']!==actor.name&&memberRole!=='manager')refuse('forbidden',`Only ${String(message['author'])} or a conversation manager can stop this turn.`);
      if(message['status']==='running'){
        this.db.prepare('UPDATE team_message SET stop_requested=1 WHERE message=?').run(id);
        if(message['turn_id']!==null){const turn=this.store.getMateTurn(Number(message['turn_id']));if(turn)this.store.finalizeMateTurn(turn.id,turn.generation,{state:'failed',settledMicrousd:turn.reservedMicrousd,unknownSpend:true,tokensIn:0,tokensOut:0,failureReason:'stopped'},now);}
      }
      else if(message['status']==='queued'||message['status']==='uncertain')this.db.prepare("UPDATE team_message SET status='cancelled',revision=revision+1,generation=generation+1,stop_requested=1 WHERE message=?").run(id);
      else refuse('finished','This message has already finished.');
      this.event(lead.id,conversationId,'stop-requested',actor.name,now);return ok('Stop requested.',{messageId:id});
    }
    if(request.operation==='edit'||request.operation==='withdraw'){
      if(message['author']!==actor.name)refuse('forbidden','Only the author can change a queued message.');
      if(Number(message['revision'])!==integer(a['expectedRevision'])||message['status']!=='queued')refuse('conflict','This message changed or has started. Send a follow-up instead.');
      if(request.operation==='edit'){const text=messageText(a['text']);this.db.prepare('UPDATE mate_message SET text=? WHERE id=?').run(text,id);this.db.prepare('UPDATE team_message SET revision=revision+1 WHERE message=?').run(id);}
      else this.db.prepare("UPDATE team_message SET status='cancelled',revision=revision+1 WHERE message=?").run(id);
      this.event(lead.id,conversationId,'message-updated',actor.name,now);return ok(request.operation==='edit'?'Message updated.':'Message withdrawn.',{messageId:id});
    }
    refuse('unsupported','This action is not available here.');
  }
  private revokeMemberSessions(leadId:string,conversationId:string|null,account:string,now:Date):void {
    this.db.prepare(`UPDATE mate_session SET ended_at=?,ended_by='membership-changed' WHERE approver=? AND ended_at IS NULL
      AND EXISTS(SELECT 1 FROM team_mate_session ms JOIN team_conversation c ON c.thread=ms.thread
      WHERE ms.session=mate_session.id AND c.lead=? AND (? IS NULL OR c.id=?))`).run(now.toISOString(),account,leadId,conversationId,conversationId);
  }
  private memberRevisions(conversationId:string,account:string):{lead:number;participant:number}|null {
    const row=this.db.prepare(`SELECT lm.revision AS lr,p.revision AS pr FROM team_conversation c JOIN team_lead_member lm ON lm.lead=c.lead AND lm.account=? AND lm.active=1 JOIN team_participant p ON p.conversation=c.id AND p.account=lm.account AND p.active=1 WHERE c.id=?`).get(account,conversationId);
    return row?{lead:Number(row['lr']),participant:Number(row['pr'])}:null;
  }
  private authorStillAllowed(row:Row):boolean {
    try{const actor={name:String(row['author']),generation:Number(row['author_generation'])};const a=this.access(actor,String(row['conversation']),'contributor'),r=this.memberRevisions(a.conversation.id,actor.name);return a.lead.status==='active'&&r?.lead===Number(row['lead_member_revision'])&&r.participant===Number(row['participant_revision']);}catch(e){if(e instanceof TeamRefusal)return false;throw e;}
  }
  claimNext(runner:string,now=new Date(),eligible?:(candidate:{actor:TeamActor;conversationId:string;threadId:number;messageId:number})=>boolean):TeamClaim|null {
    str(runner,'Runner',180);
    return this.store.transact(()=>{
      const candidates=this.db.prepare(`SELECT q.*,m.text,c.lead,c.thread FROM team_message q JOIN mate_message m ON m.id=q.message JOIN team_conversation c ON c.id=q.conversation JOIN team_lead l ON l.id=c.lead AND l.status='active'
        WHERE q.status='queued' AND NOT EXISTS(SELECT 1 FROM team_message live WHERE live.conversation=q.conversation AND live.status IN ('running','uncertain'))
        AND NOT EXISTS(SELECT 1 FROM team_message earlier WHERE earlier.conversation=q.conversation AND earlier.status='queued' AND earlier.message<q.message)
        AND (SELECT COUNT(*) FROM team_message running JOIN team_conversation other ON other.id=running.conversation WHERE running.status='running' AND other.lead=c.lead)<2
        ORDER BY CASE WHEN q.request_id LIKE 'team-update:%' AND m.created_at>? THEN 1 ELSE 0 END,COALESCE(c.last_claimed_at,''),q.message LIMIT 100`).all(new Date(now.getTime()-60_000).toISOString());
      for(const row of candidates){
        if(!this.authorStillAllowed(row)){this.db.prepare("UPDATE team_message SET status='cancelled',revision=revision+1,error='Access changed before this message started.' WHERE message=?").run(Number(row['message']));this.event(String(row['lead']),String(row['conversation']),'message-cancelled',String(row['author']),now);continue;}
        if(eligible&&!eligible({actor:{name:String(row['author']),generation:Number(row['author_generation'])},conversationId:String(row['conversation']),threadId:Number(row['thread']),messageId:Number(row['message'])}))continue;
        this.db.prepare("UPDATE team_message SET status='running',generation=generation+1,runner=?,claimed_at=? WHERE message=? AND status='queued'").run(runner,now.toISOString(),Number(row['message']));
        this.db.prepare('UPDATE team_conversation SET last_claimed_at=? WHERE id=?').run(now.toISOString(),String(row['conversation']));
        const lead=this.leadOf(this.leadRow(String(row['lead']))),conversation=this.access({name:String(row['author']),generation:Number(row['author_generation'])},String(row['conversation'])).conversation;
        this.event(lead.id,conversation.id,'message-started',String(row['author']),now);
        return {conversationId:conversation.id,leadId:lead.id,threadId:conversation.threadId,messageId:Number(row['message']),messageRevision:Number(row['revision']),generation:Number(row['generation'])+1,runner,actor:{name:String(row['author']),generation:Number(row['author_generation'])},text:String(row['text']),projects:conversation.projects,instructions:lead.instructions,requestId:String(row['request_id'])};
      }return null;
    });
  }
  private claimed(claim:TeamClaim):Row|undefined {return this.db.prepare(`SELECT q.* FROM team_message q JOIN team_conversation c ON c.id=q.conversation WHERE q.message=? AND q.conversation=? AND q.generation=? AND q.revision=? AND q.runner=? AND q.status='running' AND c.lead=? AND c.thread=? AND q.author=? AND q.author_generation=? AND q.request_id=?`).get(claim.messageId,claim.conversationId,claim.generation,claim.messageRevision,claim.runner,claim.leadId,claim.threadId,claim.actor.name,claim.actor.generation,claim.requestId);}
  current(claim:TeamClaim):boolean {const row=this.claimed(claim);return row!==undefined&&Number(row['stop_requested'])===0&&this.authorStillAllowed(row);}
  bindTurn(claim:TeamClaim,turnId:number):boolean {
    return this.store.transact(()=>{if(!this.current(claim))return false;const turn=this.store.getMateTurn(turnId);if(!turn||turn.thread!==claim.threadId||turn.approver!==claim.actor.name)return false;const changed=this.db.prepare('UPDATE team_message SET turn_id=? WHERE message=? AND turn_id IS NULL').run(turnId,claim.messageId);return Number(changed.changes)===1;});
  }
  finish(claim:TeamClaim,result:{status:'answered'|'failed'|'uncertain'|'cancelled';text?:string;error?:string;turnId?:number},now=new Date()):boolean {
    return this.store.transact(()=>{
      const row=this.claimed(claim);if(!row)return false;
      const allowed=this.authorStillAllowed(row),stopped=Number(row['stop_requested'])!==0;
      const status=result.status==='uncertain'?'uncertain':allowed&&!stopped?result.status:'cancelled';
      if(result.turnId!==undefined&&row['turn_id']!==null&&Number(row['turn_id'])!==result.turnId)return false;
      this.db.prepare('UPDATE team_message SET status=?,error=?,turn_id=COALESCE(turn_id,?),revision=revision+1 WHERE message=?').run(status,result.error??(!allowed?'Access changed while this message was running.':stopped?'Stopped.':null),result.turnId??null,claim.messageId);
      if(allowed&&!stopped&&result.text)this.store.appendMateMessage({thread:claim.threadId,turn:result.turnId??(row['turn_id']===null?null:Number(row['turn_id'])),role:'assistant',text:result.text},now);
      this.event(claim.leadId,claim.conversationId,'message-finished',claim.actor.name,now);return true;
    });
  }
  /** A pre-admission refusal saves a waiting reason. Admitted work is never requeued. */
  defer(claim:TeamClaim,error:string,now=new Date()):boolean {
    return this.store.transact(()=>{
      const row=this.claimed(claim);if(!row||row['turn_id']!==null||!this.current(claim))return false;
      if(this.db.prepare('SELECT turn FROM mate_message WHERE id=?').get(claim.messageId)?.['turn']!==null)return false;
      const changed=this.db.prepare("UPDATE team_message SET status='queued',generation=generation+1,revision=revision+1,runner=NULL,claimed_at=NULL,error=? WHERE message=? AND status='running' AND turn_id IS NULL AND generation=?").run(error,claim.messageId,claim.generation);
      if(Number(changed.changes)!==1)return false;
      if(row['error']!==error)this.event(claim.leadId,claim.conversationId,'message-waiting',claim.actor.name,now);
      return true;
    });
  }

  /** Reconcile only recorded terminal receipts; never infer success from time or rerun a turn. */
  reconcileFinished(now=new Date()):number {
    return this.store.transact(()=>{
      const rows=this.db.prepare(`SELECT q.*,c.lead,c.thread,t.state AS turn_state,t.failure_reason FROM team_message q
        JOIN team_conversation c ON c.id=q.conversation JOIN mate_turn t ON t.id=q.turn_id
        WHERE q.status='running' AND t.state IN ('answered','failed')
        AND NOT EXISTS(SELECT 1 FROM chat_turn step WHERE step.mate_turn=t.id AND step.state IN ('queued','running'))
        ORDER BY q.message LIMIT 100`).all();
      let changed=0;
      for(const row of rows){
        // An unknown provider outcome remains a stop point even when the account
        // lost access: permission revocation is not proof an effect did not occur.
        const uncertain=this.deliveryUncertain(Number(row['turn_id']));
        const cancelled=Number(row['stop_requested'])===1||!this.authorStillAllowed(row);
        const status=uncertain?'uncertain':cancelled?'cancelled':row['turn_state']==='answered'?'answered':'failed';
        const error=uncertain?'Delivery could not be confirmed. Inspect saved activity before continuing.':cancelled?'Stopped or conversation access changed.':status==='failed'?savedFailure(row['failure_reason']):null;
        const result=this.db.prepare("UPDATE team_message SET status=?,error=?,generation=generation+1,revision=revision+1 WHERE message=? AND status='running' AND generation=?").run(status,error,Number(row['message']),Number(row['generation']));
        if(Number(result.changes)===1){changed++;this.event(String(row['lead']),String(row['conversation']),'message-reconciled',String(row['author']),now);}
      }return changed;
    });
  }

  deliveryUncertain(turnId:number):boolean { return this.db.prepare("SELECT 1 FROM chat_turn WHERE mate_turn=? AND (unknown_spend=1 OR state IN ('queued','running') OR settled_microusd IS NULL) LIMIT 1").get(turnId)!==undefined; }

  activeRunners(): string[] { return this.db.prepare("SELECT DISTINCT runner FROM team_message WHERE status='running' AND runner IS NOT NULL").all().map(r => String(r['runner'])); }

  /** Called only after the runtime proves this runner has stopped. Never repeats work. */
  recover(runner:string,now=new Date()):number {
    return this.store.transact(()=>{
      const rows=this.db.prepare("SELECT q.*,c.lead FROM team_message q JOIN team_conversation c ON c.id=q.conversation WHERE runner=? AND status='running'").all(runner);
      for(const row of rows){
        const turn=row['turn_id']===null?null:this.store.getMateTurn(Number(row['turn_id']));
        const status=turn?.state==='answered'?'answered':turn?.state==='failed'&&!this.deliveryUncertain(turn.id)?'failed':'uncertain';
        const error=status==='uncertain'?'Delivery unconfirmed after the previous worker stopped. Inspect activity before continuing.':status==='failed'?savedFailure(turn?.failureReason):null;
        this.db.prepare('UPDATE team_message SET status=?,generation=generation+1,revision=revision+1,error=? WHERE message=?').run(status,error,Number(row['message']));
        this.event(String(row['lead']),String(row['conversation']),status==='uncertain'?'delivery-unconfirmed':'message-reconciled',String(row['author']),now);
      }return rows.length;
    });
  }
  followGrants():{actor:TeamActor;conversation:TeamConversation;lead:TeamLead}[]{
    const grants:{actor:TeamActor;conversation:TeamConversation;lead:TeamLead}[]=[];
    for(const row of this.db.prepare('SELECT * FROM team_follow WHERE enabled=1').all()){const actor={name:String(row['account']),generation:Number(row['generation'])};try{const a=this.access(actor,String(row['conversation']),'contributor');if(a.lead.status==='active'&&a.conversation.follow)grants.push({actor,conversation:a.conversation,lead:a.lead});}catch(e){if(!(e instanceof TeamRefusal))throw e;}}
    return grants;
  }
  taskOwner(taskId:string):{leadId:string;revision:number;conversationId:string|null}|null {
    const status=this.store.revisionAncestryStatus(taskId);if(status.problem!==null)return null;const ancestry=status.chain;const root=ancestry[ancestry.length-1];const ref=this.store.lookupRef(root??taskId);if(!ref)return null;
    const row=this.db.prepare('SELECT lead,revision,conversation FROM team_task_owner WHERE task_ref=?').get(ref.id);return row?{leadId:String(row['lead']),revision:Number(row['revision']),conversationId:row['conversation']===null?null:String(row['conversation'])}:null;
  }
  /** Attach newly filed work in its original admission transaction. Never steals an existing owner. */
  recordTaskOwner(taskId:string,leadId:string,conversationId:string|null,actor:TeamActor,now=new Date()):boolean {
    return this.store.transact(()=>{
      const lead=this.leadAccess(actor,leadId,'contributor').lead;
      const ancestry=this.store.revisionAncestryStatus(taskId);if(ancestry.problem!==null)return false;
      const ref=this.store.lookupRef(ancestry.chain[ancestry.chain.length-1]??taskId);
      if(!ref||ref.repo===null||!lead.projects.includes(ref.repo)||!this.store.accountCanAccess(actor.name,ref.repo))return false;
      if(conversationId){const access=this.access(actor,conversationId,'contributor');if(access.lead.id!==leadId||!access.conversation.projects.includes(ref.repo))return false;}
      const changed=this.db.prepare('INSERT INTO team_task_owner(task_ref,lead,conversation,changed_by,changed_at) VALUES(?,?,?,?,?) ON CONFLICT(task_ref) DO NOTHING').run(ref.id,leadId,conversationId,actor.name,now.toISOString());
      if(Number(changed.changes)===1)this.event(leadId,conversationId,'task-owner-changed',actor.name,now);
      return Number(changed.changes)===1;
    });
  }
  private transfer(actor:TeamActor,a:Record<string,unknown>,now:Date):TeamResponse {
    const taskId=str(a['taskId'],'Task'),leadId=str(a['leadId'],'Lead');
    const target=this.leadAccess(actor,leadId,'manager').lead,ancestry=this.store.revisionAncestryStatus(taskId);if(ancestry.problem!==null)refuse('invalid-task','Task history needs inspection before ownership can change.');const ref=this.store.lookupRef(ancestry.chain[ancestry.chain.length-1]??taskId);
    if(!ref||ref.repo===null||!target.projects.includes(ref.repo)||!this.store.accountCanAccess(actor.name,ref.repo))refuse('forbidden','The receiving lead must have access to this task’s project.');
    const old=this.taskOwner(taskId),expected=integer(a['expectedRevision']);if((old?.revision??0)!==expected)refuse('conflict','Task ownership changed. Reload before transferring.');
    if(old)this.leadAccess(actor,old.leadId,'manager');
    const conversationId=a['conversationId']===undefined?null:str(a['conversationId'],'Conversation');
    if(conversationId){const destination=this.access(actor,conversationId,'contributor');if(destination.lead.id!==leadId||!destination.conversation.projects.includes(ref.repo))refuse('forbidden','Choose a conversation belonging to the receiving lead and task project.');}
    this.db.prepare('INSERT INTO team_task_owner(task_ref,lead,conversation,changed_by,changed_at) VALUES(?,?,?,?,?) ON CONFLICT(task_ref) DO UPDATE SET lead=excluded.lead,conversation=excluded.conversation,revision=team_task_owner.revision+1,changed_by=excluded.changed_by,changed_at=excluded.changed_at').run(ref.id,leadId,conversationId,actor.name,now.toISOString());
    this.store.recordAction({at:now.toISOString(),actor:actor.name,repo:ref.repo,taskId,runId:null,action:'task lead transferred',outcome:JSON.stringify({from:old?.leadId??null,to:leadId,revision:expected+1}),source:'work'});
    this.event(leadId,null,'task-owner-changed',actor.name,now);if(old&&old.leadId!==leadId)this.event(old.leadId,null,'task-owner-changed',actor.name,now);
    return {version:1,ok:true,code:'ok',message:'Task responsibility transferred.',result:{taskId,leadId,revision:expected+1}};
  }
}
