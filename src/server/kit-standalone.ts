/**
 * The kit's behaviour for a server page the workspace bundle doesn't place (src/design/KIT.md): a chromed page
 * answered without the React workspace (a bearer or link session, or a build without browser assets). It is the
 * same behaviour src/browser/kit/behavior.ts gives kit markup inside the workspace, kept small and dependency-free so
 * it can ride the page's one nonce'd script (serve.ts sendScreen):
 *
 * - the composer grows from its rows to its max rows and then scrolls, and keeps "has text" and a gated send in step;
 * - a gated send does nothing while the box is empty;
 * - an idea (`data-k-draft`) adds its words to its composer in place;
 * - the composer's project chip and + open a small menu;
 * - overlays (`data-k-open`, `data-k-close`): the page behind inert, Tab kept inside, Escape, Close and the scrim close
 *   it, focus returns to the trigger; a popover or menu becomes a bottom sheet on a phone;
 * - a button switch (`button.k-switch[role=switch][data-k-switch]`) flips and says its new state;
 * - the phone keyboard: html.kb-open and --kb from the visual viewport.
 *
 * It reads no field but a composer's own text, posts nothing and fetches nothing: every control still works as plain
 * HTML without it. It never rides a sensitive page (one that asks for a password or shows a secret), where the page
 * carries no chrome additions.
 */
export const KIT_STANDALONE_SCRIPT = `(function(){
if(window.__kitStandalone)return;window.__kitStandalone=1;var d=document;
var PHONE="(max-width: 760px)";var FOCUSABLE='a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
function phone(){return window.matchMedia(PHONE).matches;}
function sync(t){var box=t.closest(".k-composer");if(!box)return;var st=getComputedStyle(t);var line=parseFloat(st.lineHeight)||21;
var pad=(parseFloat(st.paddingTop)||0)+(parseFloat(st.paddingBottom)||0);var max=line*(Number(t.getAttribute("data-max"))||8)+pad;var min=line*(Number(t.getAttribute("data-min"))||1)+pad;
t.style.height="auto";t.style.height=Math.max(min,Math.min(t.scrollHeight,max))+"px";t.style.overflowY=t.scrollHeight>max+1?"auto":"hidden";
var on=t.value.trim()!=="";box.classList.toggle("has-text",on);var sends=box.querySelectorAll(".k-send[data-gate]:not(:disabled)");for(var i=0;i<sends.length;i++)sends[i].setAttribute("aria-disabled",String(!on));}
function syncAll(){var all=d.querySelectorAll(".k-composer-ta");for(var i=0;i<all.length;i++)sync(all[i]);}
var stack=[];
function visible(el){return !!el&&el.isConnected&&el.getClientRects().length>0;}
function openPanel(panel,trigger,onClose){if(stack.length)closeTop("close");var floating=panel.classList.contains("k-pop");var ph=phone();
if(!panel.isConnected)d.body.appendChild(panel);var scrim=d.createElement("div");scrim.className="k-scrim"+(!floating||ph?" dim":"");panel.parentNode.insertBefore(scrim,panel);
panel.hidden=false;panel.setAttribute("aria-modal","true");if(!panel.hasAttribute("tabindex"))panel.tabIndex=-1;panel.classList.toggle("as-sheet",floating&&ph);
if(floating&&!ph&&trigger){var at=trigger.getBoundingClientRect();var w=panel.offsetWidth||336,h=panel.offsetHeight||200;var left=Math.min(Math.max(8,at.right-w),window.innerWidth-w-8);var below=at.bottom+6;var top=below+h>window.innerHeight-8?Math.max(8,at.top-h-6):below;panel.style.left=Math.round(left)+"px";panel.style.top=Math.round(top)+"px";}
var inerted=[];for(var node=panel;node!==d.body&&node.parentElement;node=node.parentElement){var kids=node.parentElement.children;for(var i=0;i<kids.length;i++){var s=kids[i];if(s===node||s===scrim||s.inert)continue;s.inert=true;inerted.push(s);}}
var entry={panel:panel,scrim:scrim,trigger:trigger,inerted:inerted,onClose:onClose};stack.push(entry);scrim.addEventListener("click",function(){closeEntry(entry);});
var first=panel.querySelector("[autofocus]")||panel.querySelector('input:not([type="hidden"]), textarea, select')||panel;first.focus();}
function closeEntry(entry){var at=stack.indexOf(entry);if(at<0)return;stack.splice(at,1);for(var i=0;i<entry.inerted.length;i++)entry.inerted[i].inert=false;
entry.scrim.remove();entry.panel.hidden=true;entry.panel.classList.remove("as-sheet");if(visible(entry.trigger))entry.trigger.focus();if(entry.onClose)entry.onClose();}
function closeTop(){var top=stack[stack.length-1];if(top)closeEntry(top);}
function menu(trigger,title,items){var ph=phone();var panel=d.createElement("div");panel.className=ph?"k-sheet":"k-pop k-pop-menu";panel.setAttribute("role","dialog");
var id="k-menu-"+Math.random().toString(36).slice(2,8);panel.setAttribute("aria-labelledby",id);var head=d.createElement("div");head.className=ph?"k-sheet-h":"k-pop-h";
var h=d.createElement(ph?"h2":"h3");h.id=id;h.textContent=title;var x=d.createElement("button");x.type="button";x.className="k-btn k-btn-ghost k-btn-sm k-btn-icon";x.setAttribute("aria-label","Close");x.setAttribute("data-k-close","");x.textContent="\\u00d7";
head.appendChild(h);head.appendChild(x);var list=d.createElement("div");list.className="k-menu";var entry;
items.forEach(function(item){var b=d.createElement("button");b.type="button";b.textContent=item.current?item.label+" \\u00b7 current":item.label;if(item.current)b.setAttribute("aria-current","true");b.addEventListener("click",function(){closeTop();item.act();});list.appendChild(b);});
panel.appendChild(head);panel.appendChild(list);openPanel(panel,trigger,function(){panel.remove();});}
function composerMenu(target){var chip=target.closest("[data-k-composer-project]");var plus=target.closest("[data-k-composer-plus]");var id=chip?chip.getAttribute("data-k-composer-project"):plus?plus.getAttribute("data-k-composer-plus"):null;if(id===null)return false;
var hidden=d.getElementById(id+"-project");function choose(trigger){if(!hidden)return;var items=[];try{var parsed=JSON.parse(hidden.getAttribute("data-items")||"[]");if(Array.isArray(parsed))items=parsed.filter(function(one){return typeof one==="string";});}catch(e){items=[];}
menu(trigger,"Project",items.map(function(name){return{label:name,current:name===hidden.value,act:function(){hidden.value=name;var c=d.querySelector('[data-k-composer-project="'+CSS.escape(id)+'"]');if(c){var l=c.querySelector("[data-k-project-name]");if(l)l.textContent=name;c.setAttribute("aria-label","Project: "+name+". Change");}hidden.dispatchEvent(new Event("change",{bubbles:true}));}};}));}
if(chip){choose(chip);return true;}var attach=d.querySelector('input[type="file"][data-k-attach="'+CSS.escape(id)+'"]');var items=[];if(attach)items.push({label:"Attach a file",act:function(){attach.click();}});
if(hidden)items.push({label:"Choose project",act:function(){choose(d.querySelector('[data-k-composer-project="'+CSS.escape(id)+'"]')||plus);}});if(items.length)menu(plus,"Add to your message",items);return true;}
d.addEventListener("input",function(e){var t=e.target;if(t&&t.classList&&t.classList.contains("k-composer-ta"))sync(t);});
d.addEventListener("click",function(e){var t=e.target;if(!t||!t.closest)return;
if(t.closest('.k-send[data-gate][aria-disabled="true"]')){e.preventDefault();return;}
var draft=t.closest("[data-k-draft]");if(draft){var box=d.getElementById((draft.getAttribute("data-k-into")||"")+"-text");if(box&&!box.disabled){e.preventDefault();var words=draft.getAttribute("data-k-draft")||"";var typed=box.value;
box.value=typed.trim()===""?words:typed.indexOf(words)>=0?typed:typed.replace(/\\s+$/,"")+"\\n"+words;sync(box);box.focus();}return;}
if((t.closest("[data-k-composer-project]")||t.closest("[data-k-composer-plus]"))&&composerMenu(t)){e.preventDefault();return;}
var opener=t.closest("[data-k-open]");if(opener){var panel=d.getElementById(opener.getAttribute("data-k-open")||"");if(panel){e.preventDefault();openPanel(panel,opener);}return;}
if(t.closest("[data-k-close]")){var top=stack[stack.length-1];if(top&&top.panel.contains(t)){e.preventDefault();closeEntry(top);}return;}
var sw=t.closest("button.k-switch[role=switch][data-k-switch]");if(sw){var on=sw.getAttribute("aria-checked")!=="true";sw.setAttribute("aria-checked",String(on));var w=(sw.getAttribute("data-k-switch")||"On|Off").split("|");var s=sw.querySelector("[data-k-words]");if(s)s.textContent=(on?w[0]:w[1])||"";sw.dispatchEvent(new CustomEvent("k-switch",{bubbles:true,detail:{on:on}}));}});
d.addEventListener("keydown",function(e){var top=stack[stack.length-1];if(!top)return;if(e.key==="Escape"){e.preventDefault();closeEntry(top);return;}if(e.key!=="Tab")return;
var items=Array.prototype.filter.call(top.panel.querySelectorAll(FOCUSABLE),visible);if(!items.length){e.preventDefault();top.panel.focus();return;}var first=items[0],last=items[items.length-1];
if(e.shiftKey&&(d.activeElement===first||d.activeElement===top.panel)){e.preventDefault();last.focus();}else if(!e.shiftKey&&d.activeElement===last){e.preventDefault();first.focus();}},true);
function kb(){var v=window.visualViewport;if(!v)return;var covered=Math.max(0,Math.round(window.innerHeight-v.height-v.offsetTop));d.documentElement.style.setProperty("--kb",covered+"px");d.documentElement.classList.toggle("kb-open",covered>80);}
if(window.visualViewport){window.visualViewport.addEventListener("resize",kb);window.visualViewport.addEventListener("scroll",kb);}
var root=d.documentElement;root.classList.add("k-js");d.addEventListener("keydown",function(e){if(e.key==="Tab"||e.key==="F6")root.classList.add("k-kbd");},true);d.addEventListener("pointerdown",function(){root.classList.remove("k-kbd");},true);
if(d.readyState==="loading")d.addEventListener("DOMContentLoaded",syncAll);else syncAll();
})();`;

/** Whether a page's markup has kit pieces the standalone behaviour wires (a composer, an overlay, a button switch, an idea). */
export const KIT_BEHAVIOR_MARKUP = /class="k-composer[ "]|data-k-open=|data-k-switch=|data-k-draft=/;
