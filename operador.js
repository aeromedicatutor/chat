// operador.js
import { db, auth } from './app.js';
import {
  ref, onValue, onChildAdded, onChildChanged, push, update, serverTimestamp, get, set, onDisconnect, remove
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";
import { signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";

const $ = s => document.querySelector(s);
const esc = s => String(s||'').replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const scroll = el => el && (el.scrollTop = el.scrollHeight);
const since = (ms)=>{const s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60);if(h>0)return`${h}h ${m%60}m`;if(m>0)return`${m}m ${s%60}s`;return`${s}s`;};
const tick = (m)=> `<span class="tick ${m.readAt?'seen':''}">${m.readAt?'✓✓':'✓✓'}</span>`;
const fmtDate = (ts)=> ts ? new Date(ts).toLocaleDateString() : '—';

function dbg(msg){
  let b=document.getElementById('opDbg');
  if(!b){ b=document.createElement('div'); b.id='opDbg';
    Object.assign(b.style,{position:'fixed',right:'10px',bottom:'10px',background:'#111a',color:'#eee',
      border:'1px solid #333',padding:'6px 8px',borderRadius:'6px',font:'12px monospace',zIndex:9999});
    document.body.appendChild(b);
  }
  b.textContent = String(msg);
}

/* ==== som / autoplay ==== */
const ding = $('#opDing');
let audioPronto=false;
function armarSom(){
  if(audioPronto) return;
  const tentar=()=>{ ding.play().then(()=>{ ding.pause(); ding.currentTime=0; audioPronto=true; }).catch(()=>{});
    document.removeEventListener('click',tentar); document.removeEventListener('keydown',tentar); };
  document.addEventListener('click',tentar,{once:true}); document.addEventListener('keydown',tentar,{once:true});
}

/* ==== elementos ==== */
const roomsList=$('#roomsList'), filterInput=$('#filterInput');
const roomTitle=$('#roomTitle'), roomSub=$('#roomSub'), roomOnlineDot=$('#roomOnlineDot'), waitBadge=$('#waitBadge');
const opTyping=$('#opTyping');
const opMessages=$('#opMessages'), opForm=$('#opForm'), opInput=$('#opInput'), btnFinish=$('#btnFinish');
const btnExport=$('#btnExport'); const btnRegister=$('#btnRegister');
const opOverlay=$('#opOverlay'); const btnOverlayDelete=$('#btnOverlayDelete');

/* ==== estado ==== */
let currentRoom=null, currentMsgsRef=null, allChats={}, filterTerm='', waitInt=null;

/* ==== sessão ==== */
async function ensureOpSession(){ try{ await signInAnonymously(auth); }catch(_){} }
onAuthStateChanged(auth, async (u)=>{
  if(!u) return;
  const opRef = ref(db, `operators/${u.uid}`);
  try{
    await set(opRef, { online:true, at:serverTimestamp() });
    onDisconnect(opRef).remove().catch(()=>{});
    dbg('operador ok, ouvindo chats…');
    listenChats();
  }catch(e){ dbg('erro operador: '+(e?.code||e?.message||e)); }
});

/* ==== lista de conversas (agora com badge de alerta + data + status pill) ==== */
function renderList(){
  roomsList.innerHTML='';
  const now=Date.now();
  const arr = Object.entries(allChats)
    .filter(([,c])=>!(c?.status?.disconnectedAt && now-c.status.disconnectedAt>5000))
    .sort(([,a],[,b])=>{
      const pa=a.lastMessageRole==='user'?1:0, pb=b.lastMessageRole==='user'?1:0;
      if(pb-pa!==0) return pb-pa;
      return (b.lastMessageAt||0)-(a.lastMessageAt||0);
    });

  arr.forEach(([id,c])=>{
    const label=((c.userLabel||id)+' '+(c.assunto||'')).toLowerCase();
    if(filterTerm && !label.includes(filterTerm)) return;

    const el=document.createElement('div'); el.className='room'; el.dataset.id=id;

    // Status pill (online/offline)
    const online = !!c.status?.userOnline;
    const pill=document.createElement('span');
    pill.className = `status ${online?'online':'offline'}`;
    pill.innerHTML = `<span class="dot"></span> ${online?'online':'offline'}`;
    el.appendChild(pill);

    // Centro: título + snippet + meta
    const mid=document.createElement('div'); mid.style.flex='1';
    const t=document.createElement('div'); t.className='title';
    t.textContent = `${c.userLabel||'Usuário'} • ${c.assunto||''}`;
    const s=document.createElement('div'); s.className='sub';
    const lm = c.lastMessage ? `${c.lastMessage.slice(0,60)}${c.lastMessage.length>60?'…':''}` : 'Sem mensagens';
    s.innerHTML = lm;
    const meta=document.createElement('div'); meta.className='meta-line';
    meta.innerHTML = `<span>Data: ${fmtDate(c.createdAt)}</span>`;
    mid.appendChild(t); mid.appendChild(s); mid.appendChild(meta);
    el.appendChild(mid);

    // Direita: badge + “aguardando”
    const right=document.createElement('div'); right.style.display='flex'; right.style.flexDirection='column'; right.style.alignItems='flex-end'; right.style.gap='6px';
    // Badge de alerta se houve alerta recente (últimos 10 min)
    const TEN = 10*60*1000;
    if (c.alerts?.lastAt && (now - c.alerts.lastAt) < TEN){
      const b=document.createElement('span'); b.className='badge-alert'; b.textContent='⚠ alerta';
      right.appendChild(b);
    }
    const wait=document.createElement('div'); wait.className='wait';
    wait.textContent=(c.lastMessageRole==='user'&&c.lastMessageAt)?since(Date.now()-c.lastMessageAt):'—';
    right.appendChild(wait);
    el.appendChild(right);

    el.addEventListener('click',()=>openRoom(id));
    roomsList.appendChild(el);
  });

  if(!roomsList.children.length){
    const empty=document.createElement('div');
    empty.style.cssText='padding:14px;color:#9aa6b2;font-size:13px';
    empty.textContent='Sem chats ainda. Abra um chat pela tela do usuário.';
    roomsList.appendChild(empty);
  }
}

function listenChats(){
  onValue(ref(db,'chats'), s=>{
    allChats=s.val()||{};
    dbg(`operador ok, ouvindo chats… (${Object.keys(allChats).length} salas)`);
    renderList();
  }, err=>{
    dbg('erro leitura /chats: '+(err?.code||err?.message||err));
    console.error('[operador] onValue /chats',err);
  });
  filterInput.addEventListener('input',()=>{ filterTerm=filterInput.value.trim().toLowerCase(); renderList(); });
}

/* ==== abrir sala ==== */
function openRoom(id){
  currentRoom=id; roomTitle.textContent=id; opMessages.innerHTML='';
  currentMsgsRef=ref(db,`chats/${id}/messages`);

  update(ref(db,`chats/${id}/status`),{adminOnline:true}).catch(()=>{});

  // status pill no header
  onValue(ref(db,`chats/${id}/status/userOnline`), s=>{
    const on=!!s.val();
    roomOnlineDot.classList.toggle('online',on);
    roomOnlineDot.classList.toggle('offline',!on);
    roomOnlineDot.innerHTML = `<span class="dot"></span> ${on?'online':'offline'}`;
    roomSub.textContent = on ? 'Usuário online' : 'Usuário offline';
  });

  onValue(ref(db,`chats/${id}/status/typing/user`), s=>{
    opTyping.textContent = s.val() ? 'Usuário está digitando…' : '';
  });

  onValue(ref(db,`chats/${id}/status/closed`), s=>{
    toggleClosedUI(!!s.val());
  });

  // ALERTAS -> som e badge temporária no cabeçalho
  const alertsRef = ref(db, `chats/${id}/alerts/events`);
  onChildAdded(alertsRef, ()=>{
    armarSom(); ding?.play?.().catch(()=>{});
    waitBadge.textContent='⚠ alerta recebido'; setTimeout(()=>waitBadge.textContent='aguardando —',5000);
  });

  clearInterval(waitInt);
  const updWait=()=>{
    const c=allChats[id];
    waitBadge.textContent=(c?.lastMessageRole==='user'&&c?.lastMessageAt)?`aguardando ${since(Date.now()-c.lastMessageAt)}`:'aguardando —';
  };
  updWait(); waitInt=setInterval(updWait,1000);

  onChildAdded(currentMsgsRef, snap=>{
    const k=snap.key, m=snap.val();
    const mine=m.autorRole==='agent';
    const d=document.createElement('div'); d.id=`msg-${k}`; d.className=`msg ${mine?'me':'op'}`;
    d.innerHTML=`${esc(m.texto||'')}
      <div class="meta">${new Date(m.timestamp||Date.now()).toLocaleTimeString()} ${mine?tick(m):''}</div>`;
    opMessages.appendChild(d); scroll(opMessages);
    if(!mine){ armarSom(); ding?.play?.().catch(()=>{}); update(ref(db,`chats/${id}/messages/${k}`),{readAt:serverTimestamp()}); }
  });

  onChildChanged(currentMsgsRef, snap=>{
    const k=snap.key, m=snap.val(); const el=document.getElementById(`msg-${k}`); if(!el) return;
    const mine=m.autorRole==='agent'; if(mine){ const meta=el.querySelector('.meta');
      if(meta) meta.innerHTML=`${new Date(m.timestamp||Date.now()).toLocaleTimeString()} ${tick(m)}`; }
  });

  opInput.disabled=false; opForm.querySelector('button').disabled=false; btnFinish.disabled=false; btnRegister.disabled=false;
  btnOverlayDelete.onclick = () => handleDeleteAndReset(id);

  // typing do operador -> set boolean (não update)
  opInput.addEventListener('input', ()=>{
    set(ref(db,`chats/${id}/status/typing/admin`), !!opInput.value).catch(()=>{});
  });
}

function toggleClosedUI(closed){
  opOverlay.style.display = closed ? 'flex' : 'none';
  opInput.disabled = closed;
  opForm.querySelector('button').disabled = closed;
}

/* ==== enviar ==== */
opForm.addEventListener('submit', async (e)=>{
  e.preventDefault(); if(!currentMsgsRef||!currentRoom) return;
  const texto=opInput.value.trim(); if(!texto) return;
  const now=Date.now();
  await push(currentMsgsRef,{autorUid:auth.currentUser?.uid||null,autorName:'Operador',autorRole:'agent',texto,timestamp:now});
  await update(ref(db,`chats/${currentRoom}`),{lastMessage:texto,lastMessageAt:now,lastMessageRole:'agent',lastAgentMsgAt:now});
  opInput.value='';
  set(ref(db,`chats/${currentRoom}/status/typing/admin`), false).catch(()=>{});
});

/* ==== finalizar ==== */
btnFinish.addEventListener('click', async ()=>{
  if(!currentRoom) return;
  await update(ref(db,`chats/${currentRoom}/status`),{closed:true,queue:false});
  await push(ref(db,`chats/${currentRoom}/messages`),{autorRole:'agent',autorName:'Sistema',texto:'Atendimento finalizado.',timestamp:Date.now()});
});

/* ==== apagar + resetar user ==== */
async function handleDeleteAndReset(roomId){
  if(!roomId) return;
  const ok=confirm('Apagar chat e reiniciar o questionário do usuário?'); if(!ok) return;
  try{
    let sessionUid = allChats?.[roomId]?.sessionUid;
    if(!sessionUid){ const s=await get(ref(db,`chats/${roomId}/sessionUid`)); sessionUid=s.val(); }
    const now=Date.now();
    if(sessionUid){ await update(ref(db,`signals/${sessionUid}`),{reset:true,at:now,roomId}); }
    await update(ref(db,`chats/${roomId}`),{deletedAt:now,deletedBy:'operator'});
    await remove(ref(db,`chats/${roomId}`));
    currentRoom=null; roomTitle.textContent='Selecione um chat'; roomSub.textContent='—';
    roomOnlineDot.classList.remove('online'); roomOnlineDot.innerHTML='<span class="dot"></span> offline';
    opMessages.innerHTML=''; toggleClosedUI(false); opTyping.textContent='';
    opInput.disabled=true; opForm.querySelector('button').disabled=true; btnFinish.disabled=true; btnRegister.disabled=true;
    alert('Conversa apagada e questionário do usuário reiniciado!');
  }catch(err){ console.error('Erro ao apagar/resetar:',err); alert('Erro ao apagar/resetar. Veja o console.'); }
}

/* ==== exportar ==== */
btnExport.addEventListener('click', async ()=>{
  const snap=await get(ref(db,'chats')); const all=snap.val()||{};
  const rows=[['Usuário','Assunto','Última Msg (quem)','Última Msg','Categoria','Criado em','RoomId']];
  Object.entries(all).forEach(([rid,c])=>{
    rows.push([ c.userLabel||'', c.assunto||'', c.lastMessageRole||'', c.lastMessage||'', c.userInfo?.categoria||'', new Date(c.createdAt||Date.now()).toISOString(), rid ]);
  });
  const ws=XLSX.utils.aoa_to_sheet(rows); const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,'Chats');
  const wbout=XLSX.write(wb,{bookType:'xlsx',type:'array'});
  const blob=new Blob([wbout],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='relatorio_chats.xlsx'; a.click(); URL.revokeObjectURL(a.href);
});

/* ==== init ==== */
armarSom();
ensureOpSession();
