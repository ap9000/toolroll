/** Presentation only: no fields are read, no requests are sent, and no
 * keyboard events are captured. A focused input alone is NOT a keyboard.
 *
 * It publishes the visible area (--viewport-height, --viewport-top): a phone's
 * keyboard shrinks only the visual viewport on iOS (100dvh never moves), so a
 * full-height app shell sized to it is what keeps the composer above the keys. */
export const MOBILE_VIEWPORT_SCRIPT = String.raw`
(function(){
  var root=document.documentElement,viewport=window.visualViewport;
  if(!viewport)return;
  var phone=window.matchMedia('(max-width: 900px)'),baseline=window.innerHeight,frame=0;
  function update(){
    frame=0;
    var active=document.activeElement;
    var editing=active&&active.matches('textarea,input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]),[contenteditable=true]');
    if(!editing)baseline=window.innerHeight;
    var gap=Math.max(0,window.innerHeight-viewport.height-viewport.offsetTop);
    var open=phone.matches&&viewport.scale===1&&editing&&(gap>120||baseline-viewport.height>120);
    // A reader at the end of a thread stays there when the keyboard rises:
    // the page grows room beneath the raised composer, so the newest
    // message must follow it up instead of hiding behind it.
    var opening=open&&!root.hasAttribute('data-mobile-keyboard');
    var atEnd=opening&&window.innerHeight+window.scrollY>=root.scrollHeight-120;
    root.toggleAttribute('data-mobile-keyboard',Boolean(open));
    // A pinch zoom shrinks the visual viewport too; the shell keeps its last size then.
    if(Math.abs(viewport.scale-1)<0.01){
      root.style.setProperty('--viewport-height',Math.round(viewport.height)+'px');
      root.style.setProperty('--viewport-top',Math.max(0,Math.round(viewport.offsetTop))+'px');
    }
    root.style.setProperty('--keyboard-inset',open?Math.round(gap)+'px':'0px');
    if(atEnd)window.scrollTo({top:root.scrollHeight,behavior:'instant'});
    // In the app shell the field sits in its own scrolling panel, which the shell's new size just cut short:
    // bring it back into that panel's view once the smaller layout is in.
    if(opening&&active.closest('.so-workspace'))requestAnimationFrame(function(){active.scrollIntoView({block:'nearest',behavior:'instant'});});
  }
  function schedule(){if(!frame)frame=requestAnimationFrame(update);}
  viewport.addEventListener('resize',schedule);
  viewport.addEventListener('scroll',schedule);
  window.addEventListener('resize',schedule);
  window.addEventListener('pageshow',schedule);
  window.addEventListener('orientationchange',function(){baseline=window.innerHeight;schedule();});
  document.addEventListener('focusin',schedule);
  document.addEventListener('focusout',schedule);
  var composer=document.querySelector('.composer');
  if(composer&&window.ResizeObserver){
    new ResizeObserver(function(){root.style.setProperty('--composer-height',Math.ceil(composer.getBoundingClientRect().height)+'px');}).observe(composer);
  }
  update();
})();`;
