/** Progressive enhancement for the existing chat, not a second transport.
 * Native POSTs and server-rendered approval forms remain the authority.
 * Only the message draft is kept in this tab, for at most 24 hours.
 *
 * Package 2 (2026-09-13) extends the SAME read-only status poll: the
 * server answers with a version of the displayed facts and, when it
 * differs from the page's, server-rendered fragments for the three safe
 * regions — the thread, what follows the composer, and the task's live
 * region. The page reconciles them by stable keys, so an unchanged card
 * keeps its node, its open disclosures, and its focus; the composer is
 * never touched, so the draft, caret, and focus survive every update.
 * A reader above the latest message keeps their place and gets a
 * keyboard-usable New update button; only that act moves them.
 *
 * Sending goes to the existing endpoint once, with the existing request
 * receipt key and session binding, and is never retried by itself; the
 * draft clears only on the server's receipt for THE REQUEST THAT POLL
 * ASKED ABOUT, never for a newer send or edit that replaced it. A changed
 * or ended session, a lost sign-in, an unavailable task, denied storage,
 * and a lost connection each say so in their own words; sending waits
 * for an explicit reconnection under stale authority, and drafting stays
 * available.
 *
 * Revision (build 1550 annotations): a poll acknowledges only the request
 * it captured when it started; an answer is validated whole before any
 * state changes, so a malformed one retries instead of latching a changed
 * session or advancing a version nothing rendered; a task fragment held
 * back while the reader was inside the region lands after they leave it,
 * even when the server has nothing new; and the words carried across an
 * explicit reconnection are bound to the server-named account, the task,
 * and an expiry, so another account's tab never inherits them. */
export const CHAT_CONTINUITY_SCRIPT = String.raw`
(function(){
  var form=document.querySelector('.composer[data-chat-session]');
  if(!form)return;
  var box=form.querySelector('textarea[name="message"]'),request=form.querySelector('[name="request"]');
  var status=document.getElementById('chat-connection'),reconnect=document.getElementById('chat-reconnect'),newUpdate=document.getElementById('chat-new-update');
  var session=form.dataset.chatSession,task=form.dataset.chatTask||'',user=form.dataset.chatUser||'';
  var key='standing-orders:chat-draft:'+session+':'+task,carryKey='standing-orders:chat-carry:'+task;
  var prefix='standing-orders:chat-draft:',draft=null,sending=false,timer=null,polling=false;
  var busy=form.dataset.chatBusy==='1',version=form.dataset.chatVersion||'',storage=true,stale=false,offline=navigator.onLine===false;
  // The last send still waiting for its receipt: {request, text}. It
  // outlives an edit, so the older send still settles while the newer
  // draft (with its own fresh request) stays in the box.
  var sent=null,unread=null;
  // A task fragment the server sent while the reader was inside the live
  // region (or an approval form was open): kept until it can land safely,
  // so leaving the field is enough — no second server change is needed.
  var deferredLive=null;
  var sources=new WeakMap();
  function say(text){if(status)status.textContent=text;}
  function fresh(){var bytes=new Uint8Array(16);crypto.getRandomValues(bytes);return Array.from(bytes,function(b){return b.toString(16).padStart(2,'0');}).join('');}
  function save(){try{if(draft)sessionStorage.setItem(key,JSON.stringify(draft));else sessionStorage.removeItem(key);}catch(e){storage=false;}}
  try{
    for(var i=sessionStorage.length-1;i>=0;i--){var old=sessionStorage.key(i);if(old&&old.indexOf(prefix)===0){var item=JSON.parse(sessionStorage.getItem(old)||'null');if(!item||item.at<Date.now()-86400000||old.indexOf(prefix+session+':')!==0)sessionStorage.removeItem(old);}}
    var saved=JSON.parse(sessionStorage.getItem(key)||'null');
    if(saved&&typeof saved.text==='string'&&saved.text.length<=2000&&/^[a-f0-9]{32}$/.test(saved.request)){draft=saved;box.value=saved.text;request.value=saved.request;if(saved.submitted)sent={request:saved.request,text:saved.text};}
    // Words carried across an EXPLICIT reconnection (below): a new draft
    // under this session and lens, its own fresh request key — nothing is
    // sent, and nothing from the old session is treated as received. The
    // record is honoured only for the account the server names on this
    // page, this task, and within a day; anything else is discarded here.
    var carry=JSON.parse(sessionStorage.getItem(carryKey)||'null');sessionStorage.removeItem(carryKey);
    if(!draft&&carry&&user&&carry.owner===user&&carry.task===task&&typeof carry.text==='string'&&carry.text.length<=2000&&typeof carry.at==='number'&&carry.at>Date.now()-86400000){box.value=carry.text;draft={text:carry.text,request:request.value,submitted:false,at:Date.now()};save();}
  }catch(e){storage=false;}
  function buttons(){document.querySelectorAll('form[action="/chat"] button[type="submit"]').forEach(function(button){button.disabled=sending||stale||offline;});}
  function showReconnect(on){if(reconnect)reconnect.hidden=!on;}
  function lostAuthority(){stale=true;buttons();showReconnect(true);say('Sign in again to reconnect. Your draft stays in this tab.');}
  function changed(){stale=true;buttons();showReconnect(true);say('This conversation changed or ended. Your draft stays in this tab; reconnect to continue.');}
  function unavailable(){stale=true;buttons();showReconnect(true);say('This task is no longer available here. Your draft stays in this tab.');}
  if(reconnect)reconnect.addEventListener('click',function(){
    // The reader's own act: the unsent words ride along to the reloaded
    // page as a NEW draft, bound to this account and task; the old
    // session's draft is not resent.
    try{if(box.value.trim()&&user)sessionStorage.setItem(carryKey,JSON.stringify({text:box.value,at:Date.now(),owner:user,task:task}));}catch(e){}
    location.reload();
  });
  box.addEventListener('input',function(){
    // An edit after a send is a NEW message: its own request key, its own
    // receipt. The earlier send keeps settling on its own key.
    if(draft&&draft.submitted)request.value=fresh();
    draft=box.value===''?null:{text:box.value,request:request.value,submitted:false,at:Date.now()};save();
    if(!storage)say('Draft stays on this page only. Browser storage is unavailable.');
  });
  function bind(one){
    if(!one.querySelector('[name="request"]')){var id=document.createElement('input');id.type='hidden';id.name='request';id.value=fresh();one.appendChild(id);}
    if(!one.querySelector('[name="request-session"]')){var binding=document.createElement('input');binding.type='hidden';binding.name='request-session';binding.value=session;one.appendChild(binding);}
  }
  document.querySelectorAll('form[action="/chat"]').forEach(bind);
  // One delegated handler for every form the conversation renders now or
  // later: a refreshed card never gains a second listener or a second
  // request. Prompt buttons keep their native submit (their value is the
  // prompt); the composer sends once through fetch; other forms only get
  // a double-submit latch.
  document.addEventListener('submit',function(event){
    var one=event.target;
    if(!(one instanceof HTMLFormElement))return;
    var action=one.getAttribute('action')||'';
    if(action==='/chat'){
      // A reply in progress no longer holds the composer: a message sent now waits its turn (the lead queue).
      if(sending||stale||offline){event.preventDefault();return;}
      bind(one);
      if(one===form){
        if(!box.value.trim()){event.preventDefault();return;}
        draft={text:box.value,request:request.value,submitted:true,at:Date.now()};save();
        sent={request:request.value,text:box.value};
        event.preventDefault();send();return;
      }
      sending=true;say('Sending…');one.setAttribute('aria-busy','true');
      return;
    }
    if(action==='/chat/mate/end'){draft=null;save();}
    if(one.getAttribute('aria-busy')==='true'){event.preventDefault();return;}
    one.setAttribute('aria-busy','true');
  });
  function send(){
    sending=true;say('Sending…');form.setAttribute('aria-busy','true');buttons();
    var body=new URLSearchParams(new FormData(form));
    fetch('/chat',{method:'POST',body:body,headers:{accept:'application/json'},credentials:'same-origin',signal:AbortSignal.timeout(15000)})
      .then(function(r){
        if(r.status===401||r.status===403||r.redirected){lostAuthority();return null;}
        return r.json().then(function(data){return {status:r.status,data:data};},function(){throw new Error('response');});
      })
      .then(function(got){
        if(got===null)return;
        var data=got.data||{};
        if(data.ok===true){
          // A conversation shown before it existed (session 0) is started by its first send: that is this one.
          if(session==='0'&&typeof data.session==='number'&&data.session>0)adopt(String(data.session));
          if(String(data.session)!==session){changed();return;}
          say(data.queued===true?'Queued. It goes to the lead after the reply in progress.':'Sent. Waiting for the reply…');later(300);return;
        }
        // Refused, so nothing was received: the draft stays, editable and
        // resendable under its own key; the words are the server's.
        if(draft&&draft.submitted)draft.submitted=false;save();sent=null;
        say(typeof data.said==='string'?data.said:'Message not sent.');
        if(data.session===null)changed();
      })
      .catch(function(){
        // An uncertain send is NEVER retried here: the receipt poll says
        // whether it landed; the draft stays until it does.
        say('Message not confirmed. Check the conversation before retrying.');later(1500);
      })
      .then(function(){sending=false;form.removeAttribute('aria-busy');buttons();});
  }
  // A receipt settles exactly the request the poll asked about. A send
  // submitted after that poll started (a different key) keeps its words
  // and keeps waiting for its own receipt.
  function receipt(asked){
    if(draft&&draft.submitted&&draft.request===asked){draft=null;save();box.value='';request.value=fresh();box.dispatchEvent(new Event('input'));}
    if(sent&&sent.request===asked)sent=null;
  }
  // ---- live regions --------------------------------------------------
  function normalize(html){return html.replace(/<time\b[^>]*>[^<]*<\/time>/g,'<time></time>').replace(/ id="latest"/g,'').replace(/ aria-busy="true"/g,'');}
  function remember(container){Array.prototype.forEach.call(container.children,function(child){sources.set(child,normalize(child.outerHTML));if(child.hasAttribute('data-chat-list'))remember(child);});}
  function keyOf(el,index){return el.getAttribute('data-key')||(el.tagName+'#'+el.id+'.'+el.className+'@'+index);}
  function reconcile(container,next,report){
    var existing={};
    Array.prototype.forEach.call(container.children,function(child,index){var k=keyOf(child,index);if(!(k in existing))existing[k]=child;});
    var list=[];
    Array.prototype.forEach.call(next.children,function(incoming,index){
      var k=keyOf(incoming,index),src=normalize(incoming.outerHTML),have=existing[k],node;
      if(have&&incoming.hasAttribute('data-chat-list')&&have.hasAttribute('data-chat-list')){reconcile(have,incoming,report);node=have;delete existing[k];}
      else if(have&&sources.get(have)===src){node=have;delete existing[k];if(have.id!==incoming.id)have.id=incoming.id;}
      else{
        node=document.importNode(incoming,true);sources.set(node,src);if(node.hasAttribute('data-chat-list'))remember(node);
        if(have){delete existing[k];if(have===document.activeElement||have.contains(document.activeElement))report.focused=true;have.remove();}
        if(!report.first&&node.getAttribute('data-key')!=='said')report.first=node;
      }
      list.push(node);
    });
    list.forEach(function(node,i){var at=container.children[i];if(at!==node)container.insertBefore(node,at||null);});
    while(container.children.length>list.length)container.children[list.length].remove();
    for(var k in existing)if(existing[k].parentNode===container)existing[k].remove();
  }
  function anchor(){
    var doc=document.documentElement,atBottom=window.innerHeight+window.scrollY>=doc.scrollHeight-120;
    if(atBottom)return {bottom:true};
    var nodes=document.querySelectorAll('#chat-thread [data-key]');
    for(var i=0;i<nodes.length;i++){var r=nodes[i].getBoundingClientRect();if(r.bottom>80)return {bottom:false,node:nodes[i],top:r.top};}
    return {bottom:false};
  }
  function restore(where,report){
    if(where.bottom){if(report.first)window.scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'});return;}
    if(where.node&&where.node.isConnected){var r=where.node.getBoundingClientRect();if(Math.abs(r.top-where.top)>1)window.scrollBy({top:r.top-where.top,behavior:'instant'});}
    if(report.first&&newUpdate){if(!unread||!unread.isConnected)unread=report.first;newUpdate.hidden=false;}
  }
  if(newUpdate)newUpdate.addEventListener('click',function(){
    newUpdate.hidden=true;
    if(!unread||!unread.isConnected)return;
    var top=unread.getBoundingClientRect().top+window.scrollY-80;
    window.scrollTo({top:top,behavior:'instant'});
    if(!unread.hasAttribute('tabindex'))unread.setAttribute('tabindex','-1');
    unread.focus({preventScroll:true});unread=null;
  });
  window.addEventListener('scroll',function(){if(newUpdate&&!newUpdate.hidden&&window.innerHeight+window.scrollY>=document.documentElement.scrollHeight-120)newUpdate.hidden=true;},{passive:true});
  function markStale(live,openForm){
    if(openForm.getAttribute('data-stale')==='1')return;
    openForm.setAttribute('data-stale','1');
    var submit=openForm.querySelector('button[type="submit"]');if(submit)submit.disabled=true;
    var note=document.createElement('div');note.className='problem chat-approval-stale';note.setAttribute('role','alert');
    var strong=document.createElement('strong');strong.textContent='The plan changed since this form opened.';
    var words=document.createTextNode(' Review the current exact terms before approving. ');
    var review=document.createElement('button');review.type='button';review.className='quiet';review.textContent='Review the current plan';
    review.addEventListener('click',function(){location.reload();});
    note.appendChild(strong);note.appendChild(words);note.appendChild(review);
    var action=document.getElementById('task-chat-action');
    if(action)action.insertAdjacentElement('beforebegin',note);else live.insertAdjacentElement('afterbegin',note);
  }
  function parse(html){return new DOMParser().parseFromString('<!doctype html><body>'+html+'</body>','text/html');}
  // The live task region lands only when it is safe: never under an open
  // approval form (its password, its nonce, its digest stay exactly as
  // rendered — the stale notice above speaks for the change), never while
  // the reader is inside it. Otherwise the fragment is kept for later.
  function liveSafe(live){return !live.querySelector('form.approve-form')&&!live.contains(document.activeElement);}
  function swapLive(live,nextLive){
    reconcile(live,nextLive,{first:null,focused:false});
    Array.prototype.forEach.call(nextLive.attributes,function(attribute){live.setAttribute(attribute.name,attribute.value);});
  }
  function apply(fragments){
    // Everything is parsed and checked before the page changes: every
    // region this page has must arrive whole, or the answer is malformed
    // and nothing — not even the version — is taken from it.
    var parsed=parse(fragments.thread+(fragments.after||'')+(fragments.live||''));
    var nextThread=parsed.getElementById('chat-thread'),thread=document.getElementById('chat-thread');
    if(!nextThread||!thread)throw new Error('response');
    var after=document.getElementById('chat-after-composer'),nextAfter=parsed.getElementById('chat-after-composer');
    if(after&&!nextAfter)throw new Error('response');
    var live=document.getElementById('task-chat-live'),nextLive=parsed.getElementById('task-chat-live');
    if(live&&!nextLive)throw new Error('response');
    var where=anchor(),report={first:null,focused:false};
    reconcile(thread,nextThread,report);
    if(after)reconcile(after,nextAfter,{first:null,focused:false});
    deferredLive=null;
    if(live){if(liveSafe(live))swapLive(live,nextLive);else deferredLive=fragments.live;}
    restore(where,report);
  }
  function settleLive(){
    if(deferredLive===null)return;
    var live=document.getElementById('task-chat-live');
    if(!live){deferredLive=null;return;}
    if(!liveSafe(live))return;
    var nextLive=parse(deferredLive).getElementById('task-chat-live');
    deferredLive=null;
    if(!nextLive)return;
    var where=anchor();
    swapLive(live,nextLive);
    restore(where,{first:null,focused:false});
  }
  function guardApproval(digest){
    var live=document.getElementById('task-chat-live');if(!live)return;
    var openForm=live.querySelector('form.approve-form');
    if(openForm&&(live.getAttribute('data-approval')||'')!==digest)markStale(live,openForm);
  }
  remember(document.getElementById('chat-thread')||form);
  var liveNow=document.getElementById('task-chat-live');if(liveNow)remember(liveNow);
  // ---- the status poll -----------------------------------------------
  // The whole answer must have the shape the server writes before any of
  // it is believed. Only a complete answer can end the session (an
  // explicit session:null) or move the page; anything else is a bad
  // refresh that changes nothing and is asked again.
  function valid(data){
    if(data===null||typeof data!=='object')return false;
    if(data.session===null)return true;
    if(typeof data.session!=='number'&&typeof data.session!=='string')return false;
    if(typeof data.task!=='string')return false;
    if(data.unavailable===true)return true;
    if(typeof data.version!=='string'||typeof data.pending!=='boolean'||typeof data.received!=='boolean')return false;
    if(data.approval!==undefined&&typeof data.approval!=='string')return false;
    if(data.fragments!==undefined){
      var f=data.fragments;
      if(f===null||typeof f!=='object'||typeof f.thread!=='string')return false;
      if(f.after!==undefined&&f.after!==null&&typeof f.after!=='string')return false;
      if(f.live!==undefined&&f.live!==null&&typeof f.live!=='string')return false;
    }
    return true;
  }
  // The conversation this page's first send started: its binding and its draft move to it (a reload restores from there).
  function adopt(started){session=started;document.querySelectorAll('form[action="/chat"] [name="request-session"]').forEach(function(bound){bound.value=started;});
    try{sessionStorage.removeItem(key);}catch(e){}key='standing-orders:chat-draft:'+session+':'+task;save();}
  function later(ms){if(stale)return;clearTimeout(timer);timer=setTimeout(check,ms);}
  async function check(){
    if(polling||stale)return;
    if(document.hidden){later(5000);return;}
    polling=true;
    // The request this poll asks about is fixed here: a send submitted
    // while the answer is in flight is a different key and is not settled
    // by it.
    var asked=sent?sent.request:'';
    try{
      var query='/chat/mate/status?version='+encodeURIComponent(version)+(task?'&task='+encodeURIComponent(task):'')+(asked?'&request='+encodeURIComponent(asked):'');
      var r=await fetch(query,{cache:'no-store',signal:AbortSignal.timeout(10000)});
      if(r.status===401||r.status===403||r.redirected){lostAuthority();return;}
      if(!r.ok)throw new Error('connection');
      var data=await r.json();
      if(!valid(data))throw new Error('response');
      // Not started yet (session 0): only this send's own receipt in the started conversation proves it is the one.
      if(session==='0'&&typeof data.session==='number'&&data.session>0&&asked&&data.received===true)adopt(String(data.session));
      // A poll that lands while the first send is on its way decides nothing: that send's answer (or the poll it
      // asks for afterwards, with its request) says whether the started conversation is this page's.
      if(session==='0'&&sending&&data.session!==null&&String(data.session)!=='0'){later(1000);return;}
      if(data.session===null||String(data.session)!==session){changed();return;}
      // A late answer for another lens never lands here; the poll goes on.
      if(data.task!==task){later(5000);return;}
      if(data.unavailable===true){unavailable();return;}
      if(asked&&data.received===true)receipt(asked);
      if(typeof data.approval==='string')guardApproval(data.approval);
      if(data.version!==version){
        // A changed version is rendered or it is not taken: without its
        // fragments nothing moved, so the page keeps asking as before.
        if(data.fragments===undefined)throw new Error('response');
        apply(data.fragments);version=data.version;
      }
      settleLive();
      busy=data.pending;buttons();
      say(busy?'Reply in progress. A message you send now waits its turn.':sent?'Message not confirmed. Check the conversation before retrying.':'');
      later(busy?2500:5000);
    }catch(e){say('Connection lost. Reconnecting… Your existing work is not cancelled.');later(10000);}
    finally{polling=false;}
  }
  document.addEventListener('visibilitychange',function(){if(!document.hidden){sending=false;buttons();later(0);}});
  document.addEventListener('focusout',function(){later(0);});
  window.addEventListener('online',function(){offline=false;buttons();if(!stale)say('Connected again. Checking for updates…');later(0);});
  window.addEventListener('offline',function(){offline=true;buttons();say('Offline. Your draft stays here; sending resumes when the connection returns.');});
  window.addEventListener('pageshow',function(){sending=false;form.removeAttribute('aria-busy');buttons();later(0);});
  if(offline)say('Offline. Your draft stays here; sending resumes when the connection returns.');
  buttons();later(0);
})();`;
