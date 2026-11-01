/**
 * The settings kit's one script (docs/plans/settings-revamp.md §4), shipped as a page's functional script beside kit
 * forms (settings-kit.ts). Without it every kit form works as today: the proof field shows inline and Save posts.
 *
 * With it, a kit form that asks for a proof:
 * - moves its server-written proof field into the `<dialog>` inside the same form (the field never leaves the form);
 * - opens the dialog on submit instead of posting, remembering the pressed button;
 * - Confirm (its button, or Enter in the field) posts the form with that button (`requestSubmit(submitter)`, after the
 *   submit event that asked has finished), so its name=value and every hidden term go along unchanged; Cancel (or
 *   Escape) closes it and posts nothing, and focus returns to the button;
 * - once a kit form posts, it is pending: further submits are dropped and its Save and Confirm are disabled (after the
 *   post has taken their values), until the page is shown again, the post was cancelled, or 15 s pass;
 * - asks for nothing when the proof was left out (Passwordless) — there is no dialog then — and shows the
 *   identity-provider link when the sign-in swapped the field.
 * Each section's Save bar names what changed. The script never reads or sets a field's value except to check that a
 * required proof isn't empty; the server still proves everything.
 */
export const SETTINGS_KIT_SCRIPT = `(function(){
if(window.__soKit)return;window.__soKit=1;
var d=document;d.documentElement.classList.add("kit-js");
function label(el){var l=el.labels&&el.labels[0];if(!l&&el.closest)l=el.closest("fieldset")&&el.closest("fieldset").querySelector("legend");return l?(l.textContent||"").replace(/\\s+/g," ").trim():(el.name||"");}
function prep(f){if(f.__kit)return;f.__kit=1;
var bar=f.querySelector("[data-kit-state]");if(bar&&bar.textContent==="")bar.textContent=bar.getAttribute("data-idle")||"";
if(!f.hasAttribute("data-kit-step-up"))return;
var dl=f.querySelector("[data-kit-dialog]"),p=f.querySelector(":scope>[data-kit-proof]");
if(!dl||!p||typeof dl.showModal!=="function"){f.removeAttribute("data-kit-step-up");return;}
dl.querySelector("[data-kit-slot]").appendChild(p);
p.querySelectorAll("[required]").forEach(function(i){i.removeAttribute("required");i.setAttribute("data-kit-required","");});
dl.addEventListener("close",function(){if(f.__kitSent)return;var back=f.__kitBy||f.querySelector(".kit-save");if(back&&back.focus)back.focus();});}
function scan(root){if(root.querySelectorAll)root.querySelectorAll("form.kit-form").forEach(prep);}
scan(d);
if(typeof MutationObserver!=="undefined")new MutationObserver(function(list){list.forEach(function(m){m.addedNodes.forEach(function(n){if(n.nodeType===1){if(n.matches&&n.matches("form.kit-form"))prep(n);scan(n);}});});}).observe(d.documentElement,{childList:true,subtree:true});
function asks(dl){var slot=dl.querySelector("[data-kit-slot]");return !!slot.querySelector("input:not([type=hidden]),a,.sso-step-up");}
function confirm(f){var dl=f.querySelector("[data-kit-dialog]"),miss=null;
dl.querySelectorAll("[data-kit-required]").forEach(function(i){if(!miss&&i.value==="")miss=i;});
if(miss){miss.setCustomValidity("Enter your password.");miss.reportValidity();miss.focus();return;}
var by=f.__kitBy&&f.__kitBy.form===f?f.__kitBy:null;f.__kitSent=1;dl.close();
setTimeout(function(){f.__kitGo=1;try{by?f.requestSubmit(by):f.requestSubmit();}finally{f.__kitGo=0;}},0);}
function buttons(f){return f.querySelectorAll(".kit-save,[data-kit-confirm]");}
function release(f){f.__kitPending=0;f.__kitSent=0;clearTimeout(f.__kitTimer);buttons(f).forEach(function(b){b.disabled=false;});}
function latch(f,e){f.__kitPending=1;setTimeout(function(){if(e.defaultPrevented){release(f);return;}
buttons(f).forEach(function(b){b.disabled=true;});f.__kitTimer=setTimeout(function(){release(f);},15000);},0);}
addEventListener("pageshow",function(){d.querySelectorAll("form.kit-form").forEach(release);});
d.addEventListener("submit",function(e){var f=e.target;if(!f||!f.classList||!f.classList.contains("kit-form"))return;prep(f);
if(f.__kitPending){e.preventDefault();e.stopImmediatePropagation();return;}
var dl=f.hasAttribute("data-kit-step-up")?f.querySelector("[data-kit-dialog]"):null;
if(f.__kitGo||!dl||!asks(dl)){latch(f,e);return;}
e.preventDefault();e.stopImmediatePropagation();
if(dl.open){confirm(f);return;}
f.__kitBy=e.submitter||null;f.__kitSent=0;dl.showModal();
var first=dl.querySelector("[data-kit-slot] input:not([type=hidden]),[data-kit-slot] a")||dl.querySelector("[data-kit-confirm]");if(first)first.focus();},true);
d.addEventListener("click",function(e){var b=e.target&&e.target.closest?e.target.closest("[data-kit-confirm],[data-kit-cancel]"):null;if(!b)return;
var dl=b.closest("[data-kit-dialog]"),f=dl&&dl.closest("form");if(!f)return;e.preventDefault();
if(b.hasAttribute("data-kit-cancel")){dl.close();return;}confirm(f);});
d.addEventListener("input",function(e){var t=e.target;if(t&&t.setCustomValidity&&t.hasAttribute&&t.hasAttribute("data-kit-required"))t.setCustomValidity("");},true);
function changed(e){var t=e.target,f=t&&t.form;if(!f||!f.classList.contains("kit-form")||t.closest("[data-kit-dialog]")||t.type==="hidden")return;prep(f);
var bar=f.querySelector("[data-kit-save-bar]"),state=f.querySelector("[data-kit-state]");if(!bar||!state)return;
f.__kitChanged=f.__kitChanged||[];var name=label(t);if(name&&f.__kitChanged.indexOf(name)<0)f.__kitChanged.push(name);
bar.setAttribute("data-changed","");state.textContent="Changed: "+f.__kitChanged.join(", ");}
d.addEventListener("input",changed);d.addEventListener("change",changed);
})();`;

/** The pages that wear the settings frame: one column, no Crew sheet, a breadcrumb under Settings. Here (not in
 * settings-kit.ts) so the browser bundle reads it without the server's form contracts. */
export function isSettingsFrame(pathname: string): boolean {
  return pathname === "/settings" || pathname.startsWith("/settings/") || pathname === "/setup" || pathname.startsWith("/setup/")
    || pathname === "/people" || pathname === "/mode" || pathname === "/control" || pathname === "/spend";
}
