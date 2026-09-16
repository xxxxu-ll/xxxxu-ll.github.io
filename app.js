(() => {
  'use strict';
  const data = window.QUOTES;
  const meta = [
    {name:'老子',seal:'道',school:'道家 · 自然无为',description:'在万物的流转中，体会柔弱与自然的力量。',color:'#d8c39a',x:.35,y:.43},
    {name:'孔子',seal:'仁',school:'儒家 · 仁礼修身',description:'从日常的学习与相处，走向仁爱与自我修养。',color:'#a9c9e3',x:.70,y:.29},
    {name:'墨子',seal:'兼',school:'墨家 · 兼爱非攻',description:'以平等的关爱与切实的行动，回应天下的需要。',color:'#91c3b7',x:.79,y:.62},
    {name:'庄子',seal:'游',school:'道家 · 逍遥齐物',description:'松开成见的束缚，在万物之间寻找精神的自由。',color:'#b8aad9',x:.21,y:.73},
    {name:'孟子',seal:'义',school:'儒家 · 性善养气',description:'守住恻隐之心，在每一次选择中涵养浩然之气。',color:'#d4a595',x:.54,y:.79}
  ];
  const $ = id => document.getElementById(id);
  let selected=0, quote=0, zoom=1, list=false, frame=0, libraryAuthor=0, page=0;
  const pageSize=10, starSlots=100;
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
  let paused=reduced.matches;
  const canvas=$('stars'),ctx=canvas.getContext('2d');
  let width=1,height=1;
  const pad=n=>String(n).padStart(2,'0');
  function el(tag,text,className){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;}
  function sourceLink(q){const a=el('a',q.source+' ↗','source');a.href=q.url;a.target='_blank';a.rel='noopener noreferrer';a.setAttribute('aria-label',q.source+'（在新标签页打开原典）');return a;}
  function position(m){return {x:(m.x-.5)*zoom+.5,y:(m.y-.56)*zoom+.56};}
  function select(a,q=0){selected=a;quote=q;libraryAuthor=a;page=0;renderReading();renderButtons();if(list)renderLibrary();draw(performance.now());}
  function selectStar(a,q=0){select(a,q);if(window.innerWidth<=800){$('reading').scrollIntoView({behavior:paused?'auto':'smooth',block:'start'});$('reading').focus({preventScroll:true});}}
  function renderReading(){const m=meta[selected],q=data[selected].quotes[quote];$('author-name').textContent=m.name;$('author-school').textContent=m.school;$('author-description').textContent=m.description;$('seal').textContent=m.seal;$('seal').style.color=m.color;$('author-number').textContent=pad(selected+1);$('quote-counter').textContent=pad(quote+1)+' / '+pad(data[selected].quotes.length);$('quote-text').textContent=q.text;$('quote-source').replaceWith(Object.assign(sourceLink(q),{id:'quote-source'}));$('quote-meaning').textContent=q.meaning;}
  function renderButtons(){document.querySelectorAll('[data-author]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.author)===selected)));document.querySelectorAll('.quote-star').forEach(b=>{const a=Number(b.dataset.a),slot=Number(b.dataset.slot);const start=a===selected?Math.floor(quote/starSlots)*starSlots:0;const index=(start+slot)%data[a].quotes.length;b.dataset.q=index;b.setAttribute('aria-label',meta[a].name+'，第'+(index+1)+'则：'+data[a].quotes[index].text);b.title=data[a].quotes[index].text;b.setAttribute('aria-pressed',String(a===selected&&index===quote));});}
  meta.forEach((m,a)=>{
    const b=el('button',undefined,'star-label');b.style.setProperty('--star-color',m.color);b.dataset.author=a;b.setAttribute('aria-label',m.name+'，'+m.school+'，'+data[a].quotes.length+'则语录');b.append(el('span',undefined,'star-dot'),el('strong',m.name),el('small',m.school.split(' · ')[1]));b.addEventListener('click',()=>selectStar(a));$('star-controls').append(b);
    data[a].quotes.slice(0,starSlots).forEach((q,i)=>{const s=el('button',undefined,'quote-star');s.style.setProperty('--star-color',m.color);s.style.setProperty('--twinkle-delay',((i*0.13+a*.8)%6).toFixed(2)+'s');s.style.setProperty('--drift-x',(Math.sin(i*1.71+a)*3.5).toFixed(1)+'px');s.style.setProperty('--drift-y',(Math.cos(i*1.29+a*.7)*3.5).toFixed(1)+'px');s.dataset.a=a;s.dataset.q=i;s.dataset.slot=i;s.setAttribute('aria-label',m.name+'，第'+(i+1)+'则：'+q.text);s.title=q.text;s.addEventListener('click',()=>selectStar(a,Number(s.dataset.q)));$('star-controls').append(s);});
    const nav=el('button');nav.style.setProperty('--star-color',m.color);nav.dataset.author=a;nav.append(el('span','✦','tiny-star'),document.createTextNode(m.name));nav.addEventListener('click',()=>select(a));$('philosophers').append(nav);
    const tab=el('button',m.name);tab.dataset.author=a;tab.addEventListener('click',()=>select(a));$('library-nav').append(tab);
  });
  function quotePosition(a,i){const p=position(meta[a]),count=data[a].quotes.length||starSlots,angle=i*2.39996+a*.6;const clusterRadius=Math.min(245,Math.max(120,Math.min(width*.28,height*.38)))*zoom;const r=clusterRadius*(.12+.88*Math.sqrt((i+1)/count));const weave=Math.sin(i*.31+a*1.7)*clusterRadius*.18;const x=p.x*width+Math.cos(angle)*r+Math.cos(angle*1.7+a)*weave;const y=p.y*height+Math.sin(angle)*r*.58+Math.sin(angle*1.35+a)*weave*.62-38;return{x,y};}
  function layout(){meta.forEach((m,a)=>{const p=position(m),b=document.querySelector('.star-label[data-author="'+a+'"]');b.style.left=p.x*100+'%';b.style.top=p.y*100+'%';});document.querySelectorAll('.quote-star').forEach(b=>{const p=quotePosition(Number(b.dataset.a),Number(b.dataset.slot));b.style.left=p.x+'px';b.style.top=p.y+'px';});}
  function renderLibrary(){
    const term=$('quote-search').value.trim().normalize('NFKC');
    const entries=data.flatMap((a,author)=>a.quotes.map((q,index)=>({q,author,index}))).filter(e=>(libraryAuthor===-1||e.author===libraryAuthor)&&(!term||[e.q.text,e.q.source,e.q.meaning,meta[e.author].name].some(s=>s.normalize('NFKC').includes(term))));
    const pages=Math.max(1,Math.ceil(entries.length/pageSize));page=Math.min(page,pages-1);
    const area=$('library-quotes');area.replaceChildren();
    entries.slice(page*pageSize,(page+1)*pageSize).forEach(({q,author,index})=>{const card=el('article',undefined,'quote-card'),head=el('header');head.append(el('span',meta[author].name+' · '+meta[author].school.split(' · ')[0]),el('span',pad(index+1)+' / '+data[author].quotes.length));const meaning=el('div',undefined,'meaning');meaning.append(el('h3','白话 · 一解'),el('p',q.meaning));card.append(head,el('blockquote',q.text),sourceLink(q),meaning);area.append(card);});
    if(!entries.length)area.append(el('p','未找到相关语录，试试其他关键词或选择“全部”。','empty-state'));
    $('result-count').textContent=(libraryAuthor===-1?'全部先贤':meta[libraryAuthor].name)+' · '+entries.length+' 则'+(entries.length?' · 当前 '+(page*pageSize+1)+'—'+Math.min((page+1)*pageSize,entries.length)+' 则':'');
    $('page-select').replaceChildren();for(let i=0;i<pages;i++){const option=el('option',String(i+1));option.value=i;$('page-select').append(option);}$('page-select').value=page;
    $('library-prev').disabled=page===0;$('library-next').disabled=page===pages-1;
    $('library-all').setAttribute('aria-pressed',String(libraryAuthor===-1));$('library-nav').querySelectorAll('[data-author]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.author)===libraryAuthor)));
  }
  function turnPage(newPage){page=newPage;renderLibrary();$('result-count').scrollIntoView({behavior:'auto',block:'start'});}
  $('library-all').addEventListener('click',()=>{libraryAuthor=-1;page=0;renderLibrary();});
  $('quote-search').addEventListener('input',()=>{page=0;renderLibrary();});
  $('search-clear').addEventListener('click',()=>{$('quote-search').value='';page=0;renderLibrary();$('quote-search').focus();});
  $('library-prev').addEventListener('click',()=>turnPage(page-1));$('library-next').addEventListener('click',()=>turnPage(page+1));$('page-select').addEventListener('change',()=>turnPage(Number($('page-select').value)));
  function setView(toList){list=toList;document.body.classList.toggle('view-library',list);$('library').hidden=!list;$('map-view').classList.toggle('active',!list);$('list-view').classList.toggle('active',list);$('map-view').setAttribute('aria-pressed',String(!list));$('list-view').setAttribute('aria-pressed',String(list));document.querySelector('.skip-link').href=list?'#library':'#reading';if(list)renderLibrary();else resize();}
  $('map-view').addEventListener('click',()=>setView(false));$('list-view').addEventListener('click',()=>setView(true));
  $('previous').addEventListener('click',()=>select(selected,(quote-1+data[selected].quotes.length)%data[selected].quotes.length));$('next').addEventListener('click',()=>select(selected,(quote+1)%data[selected].quotes.length));
  $('random').addEventListener('click',()=>{const choices=data.flatMap((a,i)=>a.quotes.map((q,j)=>[i,j])).filter(([a,q])=>a!==selected||q!==quote);const [a,q]=choices[Math.floor(Math.random()*choices.length)];select(a,q);});
  $('font-size').addEventListener('click',()=>{const on=document.body.classList.toggle('large-text');$('font-size').setAttribute('aria-pressed',String(on));$('font-size').setAttribute('aria-label',on?'恢复标准字号':'大字阅读');resize();});
  function motionLabel(){$('motion').textContent=paused?'播放动画':'暂停动画';$('motion').setAttribute('aria-pressed',String(paused));$('motion').setAttribute('aria-label',paused?'播放星河动画':'暂停星河动画');}
  $('motion').addEventListener('click',()=>{paused=!paused;motionLabel();if(!paused)start();});
  reduced.addEventListener('change',e=>{paused=e.matches;motionLabel();if(!paused)start();});
  function setZoom(z){zoom=Math.min(1.3,Math.max(.75,z));$('zoom-reset').textContent=Math.round(zoom*100)+'%';$('zoom-out').disabled=zoom<=.75;$('zoom-in').disabled=zoom>=1.3;layout();draw(performance.now());}
  $('zoom-in').addEventListener('click',()=>setZoom(zoom+.1));$('zoom-out').addEventListener('click',()=>setZoom(zoom-.1));$('zoom-reset').addEventListener('click',()=>setZoom(1));
  let seed=926;function rand(){seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;}
  const field=Array.from({length:650},()=>({x:rand(),y:rand(),r:.3+rand()*1.05,alpha:.08+rand()*.58,phase:rand()*6.28}));
  const clusters=meta.map(()=>Array.from({length:230},()=>{const a=rand()*Math.PI*2,r=Math.pow(rand(),1.55)*220;return{x:Math.cos(a)*r,y:Math.sin(a)*r*.55,r:.35+rand()*1.05,alpha:.18+rand()*.72,phase:rand()*6.28,speed:.35+rand()*1.1};}));
  function draw(t){if(!ctx||list)return;ctx.clearRect(0,0,width,height);field.forEach(s=>{ctx.fillStyle='rgba(194,208,234,'+(s.alpha*(paused?1:.78+.22*Math.sin(t*.0003+s.phase)))+')';ctx.beginPath();ctx.arc(s.x*width,s.y*height,s.r,0,Math.PI*2);ctx.fill();});
    ctx.globalCompositeOperation='lighter';
    meta.forEach((m,a)=>{const p=position(m),x=p.x*width,y=p.y*height-34,rad=(a===selected?180:135)*zoom;const glow=ctx.createRadialGradient(x,y,0,x,y,rad);glow.addColorStop(0,m.color+(a===selected?'28':'16'));glow.addColorStop(.45,m.color+'0b');glow.addColorStop(1,m.color+'00');ctx.fillStyle=glow;ctx.fillRect(x-rad,y-rad,rad*2,rad*2);clusters[a].forEach((s,index)=>{const baseAngle=Math.atan2(s.y,s.x);const distance=Math.hypot(s.x,s.y)*zoom;const angle=baseAngle+t*.000055*s.speed;const px=x+Math.cos(angle)*distance+Math.sin(t*.0011*s.speed+s.phase)*2.5;const py=y+Math.sin(angle)*distance*.62+Math.cos(t*.0009*s.speed+s.phase)*2;const pulse=.6+.4*Math.sin(t*.0022*s.speed+s.phase);ctx.globalAlpha=s.alpha*pulse*(a===selected?1:.62);ctx.fillStyle=m.color;ctx.beginPath();ctx.arc(px,py,s.r*(.75+.35*pulse),0,Math.PI*2);ctx.fill();if(index%7===0){ctx.globalAlpha*=.22;ctx.beginPath();ctx.arc(px,py,s.r*4.5,0,Math.PI*2);ctx.fill();}if(index%11===0){ctx.globalAlpha*=.45;ctx.strokeStyle=m.color+'55';ctx.lineWidth=.55;ctx.beginPath();ctx.moveTo(px,py);ctx.lineTo(px-Math.cos(angle)*s.speed*4,py-Math.sin(angle)*s.speed*2.4);ctx.stroke();}});ctx.globalAlpha=1;
      if(a===selected){ctx.strokeStyle=m.color+'30';ctx.lineWidth=.7;ctx.beginPath();data[a].quotes.slice(0,starSlots).forEach((q,i)=>{const p=quotePosition(a,i);if(i===0)ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y);});ctx.stroke();}
    });
    ctx.globalCompositeOperation='source-over';
  }
  function tick(t){frame=0;draw(t);if(!paused&&!document.hidden&&!list)frame=requestAnimationFrame(tick);}
  function start(){if(!frame&&!paused&&!document.hidden)frame=requestAnimationFrame(tick);}
  function resize(){const rect=canvas.getBoundingClientRect();if(!rect.width)return;width=rect.width;height=rect.height;const dpr=Math.min(window.devicePixelRatio||1,2);canvas.width=width*dpr;canvas.height=height*dpr;if(ctx)ctx.setTransform(dpr,0,0,dpr,0,0);layout();draw(performance.now());start();}
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)start();});window.addEventListener('resize',resize);if(window.ResizeObserver)new ResizeObserver(resize).observe(document.querySelector('.universe'));
  $('total-quotes').textContent=data.reduce((n,a)=>n+a.quotes.length,0);renderReading();renderButtons();motionLabel();resize();
})();

