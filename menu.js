'use strict';
const menuToggle=document.getElementById('menu-toggle'),siteLinks=document.getElementById('site-links');
function closeMenu(){siteLinks.hidden=true;menuToggle.setAttribute('aria-expanded','false')}
menuToggle.addEventListener('click',()=>{const open=siteLinks.hidden;siteLinks.hidden=!open;menuToggle.setAttribute('aria-expanded',String(open))});
document.addEventListener('click',e=>{if(!e.target.closest('.site-menu'))closeMenu()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!siteLinks.hidden){closeMenu();menuToggle.focus()}});
siteLinks.querySelectorAll('a').forEach(a=>{if(a.pathname===location.pathname||(a.pathname==='/'&&location.pathname==='/index.html'))a.setAttribute('aria-current','page')});

// One responsive presentation layer. Original images and analytical records stay untouched.
window.ScranUI={image(src,alt,sizes='(max-width: 600px) 88vw, (max-width: 1000px) 44vw, 30vw'){
 const escape=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const asset=window.ScranImages?.[src.replace(/^\//,'')];
 return `<img loading="lazy" decoding="async" ${asset?`width="${asset.width}" height="${asset.height}" src="${asset.small}" srcset="${asset.small} 480w, ${asset.large} 960w" sizes="${sizes}"`:`src="${escape(src)}"`} alt="${escape(alt)}">`;
}};
// Keep keyboard focus and menu state predictable on touch, keyboard and browser back.
siteLinks.addEventListener('click',e=>{if(e.target.closest('a'))closeMenu()});
document.addEventListener('focusin',e=>{if(!e.target.closest('.site-menu'))closeMenu()});
menuToggle.addEventListener('keydown',e=>{if(e.key==='ArrowDown'){e.preventDefault();siteLinks.hidden=false;menuToggle.setAttribute('aria-expanded','true');siteLinks.querySelector('a').focus()}});
window.addEventListener('pageshow',closeMenu);
for(const img of document.querySelectorAll('img[src$="scran-pints-logo.png"]')){
 const asset=window.ScranImages?.['assets/scran-pints-logo.png'];
 if(asset){img.src=asset.small;img.srcset=`${asset.small} 480w, ${asset.large} 960w`;img.sizes=img.closest('header')?'150px':img.closest('footer')?'155px':'470px';img.decoding='async';if(img.closest('footer'))img.loading='lazy';}
}
for(const detail of document.querySelectorAll('.takeaway-details,.filter-options'))detail.open=matchMedia('(min-width: 701px)').matches;
const topButton=document.createElement('a');topButton.href='#main-content';topButton.className='back-top';topButton.textContent='↑ Top';topButton.setAttribute('aria-label','Back to top');topButton.hidden=true;document.body.append(topButton);
let scrollTick=false;window.addEventListener('scroll',()=>{if(scrollTick)return;scrollTick=true;requestAnimationFrame(()=>{topButton.hidden=scrollY<900;scrollTick=false})},{passive:true});

window.ScranUI.retry=element=>{const button=document.createElement('button');button.type='button';button.className='retry-data';button.textContent='Try loading again';button.onclick=()=>location.reload();element.append(button)};
function fitMenu(){if(!siteLinks.hidden)siteLinks.style.maxHeight=Math.max(80,innerHeight-siteLinks.getBoundingClientRect().top-12)+'px'}
menuToggle.addEventListener('click',fitMenu);menuToggle.addEventListener('keydown',e=>{if(e.key==='ArrowDown')fitMenu()});window.addEventListener('resize',fitMenu);
matchMedia('(min-width: 701px)').addEventListener('change',e=>{for(const detail of document.querySelectorAll('.takeaway-details,.filter-options'))detail.open=e.matches});
