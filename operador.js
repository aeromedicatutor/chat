// operador.js v1.9
import { db, auth } from './app.js';
import {
  ref, onValue, onChildAdded, onChildChanged, push, update, serverTimestamp, get, set, remove, query, orderByChild, onDisconnect
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";
import { signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";

const $ = s => document.querySelector(s);
const esc = s => String(s||'').replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const scroll = el => el && (el.scrollTop = el.scrollHeight);
const since = (ms)=>{const s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60);if(h>0)return`${h}h ${m%60}m`;if(m>0)return`${m}m ${s%60}s`;return`${s}s`;};
const tick = (m)=> `<span class="tick ${m.readAt?'seen':''}">${m.readAt?'✓✓':'✓✓'}</span>`;
const log = { info:(...a)=>console.info('[OP]',...a), warn:(...a)=>console.warn('[OP]',...a), error:(...a)=>console.error('[OP]',...a) };

let currentRoom=null, previousRoom=null, currentMsgsRef=null, allChats={}, waitInt=null, roomIsClosed=false;
let unsubs = [];
let ding=null;

const roomTitle=$('#roomTitle'),
      roomOnlineDot=$('#roomOnlineDot'),
      roomSub=$('#roomSub'),
      opTyping=$('#opTyping'),
      opMessages=$('#opMessages'),
      opForm=$('#opForm'),
      opInput=$('#opInput'),
      btnFinish=$('#btnFinish'),
      waitBadge=$('#waitBadge'),
      opOverlay=$('#opOverlay'),
      btnOverlayDelete=$('#btnOverlayDelete'),
      roomsList=$('#roomsList'),
      filterInput=$('#filterInput'),
      btnExport=$('#btnExport');

function armarSom(){ ding = document.getElementById('opDing') || document.getElementById('ding'); }
async function ensureOpSession(){ try{ await signInAnonymously(auth); }catch(e){ log.error('auth anônima', e); } }
onAuthStateChanged(auth, user=>{ if(!user) ensureOpSession(); });

/* ===== XLSX loader (fallback dinâmico) ===== */
async function ensureXLSX(){
  if (window.XLSX) return window.XLSX;
  await new Promise((res,rej)=>{
    const s=document.createElement('script');
    s.src='https://cdn.jsdelivr.net/npm/xlsx@0.20.2/dist/xlsx.full.min.js';
    s.onload=res; s.onerror=()=>rej(new Error('Falha ao carregar XLSX'));
    document.head.appendChild(s);
  });
  return window.XLSX;
}

function toggleClosedUI(closed){
  roomIsClosed = !!closed;
  opOverlay.style.display = closed ? 'flex' : 'none';
  opInput.disabled = closed;
  opForm.querySelector('button').disabled = closed;
}

function renderRooms(filter=''){
  const sel = currentRoom;
  const term = filter.trim().toLowerCase();
  const items = Object.entries(allChats)
    .sort(([,a],[,b]) => (b.lastMessageAt||0) - (a.lastMessageAt||0))
    .filter(([,c])=>{
      if(!term) return true;
      return [c.userLabel, c.userInfo?.nome, c.assunto].filter(Boolean)
        .some(v => String(v).toLowerCase().includes(term));
    });

  roomsList.innerHTML = items.map(([id,c])=>{
    const on = !!c?.status?.userOnline;
    const lm = c?.lastMessage||'—';
    const when = c?.lastMessageAt ? since(Date.now()-c.lastMessageAt) : '—';
    const ac = c?.alerts?.count||0;
    const badge = ac>0 ? `<span class="badge-alert">${ac} ${ac===1?'alerta':'alertas'}</span>` : '';
    const unread = c?.lastMessageRole==='user' ? 'unread' : '';
    const selected = id===sel ? 'selected' : '';
    return `
      <div class="room ${unread} ${selected}" data-id="${id}">
        <div style="flex:1">
          <div class="title">${esc(c.userLabel||id)}</div>
          <div class="sub">${esc(c.assunto||'')}</div>
          <div class="meta-line">
            <span class="status ${on?'online':'offline'}"><span class="dot"></span> ${on?'online':'offline'}</span>
            ${badge}
            <span class="wait">última: ${when}</span>
          </div>
          <div class="sub" style="margin-top:4px">“${esc(lm)}”</div>
        </div>
      </div>
    `;
  }).join('');

  roomsList.querySelectorAll('.room').forEach(el=>{
    el.onclick = ()=> openRoom(el.dataset.id);
  });
}

async function startRoomsListener(){
  const orderedQ = query(ref(db, 'chats'), orderByChild('lastMessageAt'));
  try{
    const first = await get(orderedQ);
    allChats = first.val() || {};
    log.info('Listando chats (ordenado). Total:', Object.keys(allChats).length);
    renderRooms(filterInput.value||'');
    onValue(orderedQ, s=>{ allChats = s.val() || {}; renderRooms(filterInput.value||''); });
    onChildChanged(ref(db,'chats'), s=>{ allChats[s.key] = s.val(); renderRooms(filterInput.value||''); });
    onChildAdded(ref(db,'chats'), s=>{ allChats[s.key] = s.val(); renderRooms(filterInput.value||''); });
  }catch(err){
    log.warn('Query ordenada indisponível. Detalhe:', err?.message||err);
    onValue(ref(db,'chats'), s=>{ allChats = s.val() || {}; renderRooms(filterInput.value||''); });
    onChildChanged(ref(db,'chats'), s=>{ allChats[s.key] = s.val(); renderRooms(filterInput.value||''); });
    onChildAdded(ref(db,'chats'), s=>{ allChats[s.key] = s.val(); renderRooms(filterInput.value||''); });
  }
}

/* ===== Presença do operador por sala ===== */
function setAdminPresence(roomId, online){
  const p = ref(db, `chats/${roomId}/status/adminOnline`);
  set(p, online).catch(()=>{});
  if(online) onDisconnect(p).set(false);
}
function clearPreviousPresence(){
  if(previousRoom && previousRoom!==currentRoom){
    update(ref(db,`chats/${previousRoom}/status`),{adminOnline:false}).catch(()=>{});
  }
}
function zeroAlerts(roomId){
  update(ref(db, `chats/${roomId}/alerts`), { count:0 }).catch(()=>{});
  set(ref(db, `chats/${roomId}/alerts/events`), null).catch(()=>{});
}

/* ===== Abertura de sala ===== */
function openRoom(id){
  roomsList.querySelectorAll('.room.selected').forEach(r=>r.classList.remove('selected'));
  const clicked = roomsList.querySelector(`.room[data-id="${id}"]`);
  if(clicked) clicked.classList.add('selected');

  unsubs.forEach(fn => { try{ fn(); }catch(_){} }); unsubs = [];
  clearInterval(waitInt);

  previousRoom = currentRoom;
  currentRoom=id;
  clearPreviousPresence();
  setAdminPresence(id, true);
  zeroAlerts(id);

  const c = allChats[id] || {};
  roomTitle.textContent = c.userLabel || id;
  roomSub.textContent = c.assunto ? `Assunto: ${c.assunto}` : '—';
  opMessages.innerHTML='';

  currentMsgsRef=ref(db,`chats/${id}/messages`);

  onValue(ref(db,`chats/${id}/status/userOnline`), s=>{
    const on = !!s.val();
    roomOnlineDot.classList.toggle('online', on);
    roomOnlineDot.classList.toggle('offline', !on);
    roomOnlineDot.innerHTML = `<span class="dot"></span> ${on?'online':'offline'}`;
  });

  onValue(ref(db,`chats/${id}/status/typing/user`), s=>{
    opTyping.textContent = s.val() ? 'Usuário está digitando…' : '';
  });

  onValue(ref(db,`chats/${id}/status/closed`), s=> toggleClosedUI(!!s.val()) );

  onChildAdded(ref(db,`chats/${id}/alerts/events`), ()=>{
    armarSom(); ding?.play?.().catch(()=>{});
    waitBadge.textContent='aguardando —';
  });

  const updWait=()=>{
    const chat=allChats[id];
    waitBadge.textContent=(chat?.lastMessageRole==='user'&&chat?.lastMessageAt)
      ? `aguardando ${since(Date.now()-chat.lastMessageAt)}`
      : 'aguardando —';
  };
  updWait(); waitInt=setInterval(updWait,1000);

  onChildAdded(currentMsgsRef, snap=>{
    const k=snap.key, m=snap.val();
    const mine=m.autorRole==='agent';
    const d=document.createElement('div');
    d.id=`msg-${k}`;
    d.className=`msg ${mine?'me':'op'}`;
    d.innerHTML=`${esc(m.texto||'')}<div class="meta">${new Date(m.timestamp||Date.now()).toLocaleTimeString()} ${mine?tick(m):''}</div>`;
    opMessages.appendChild(d);
    scroll(opMessages);
    if(!mine){
      armarSom(); ding?.play?.().catch(()=>{});
      update(ref(db,`chats/${id}/messages/${k}`),{readAt:serverTimestamp()});
    }
  });

  onChildChanged(currentMsgsRef, snap=>{
    const k=snap.key, m=snap.val();
    const el=document.getElementById(`msg-${k}`);
    if(!el) return;
    const mine=m.autorRole==='agent';
    if(mine){
      const meta=el.querySelector('.meta');
      if(meta) meta.innerHTML=`${new Date(m.timestamp||Date.now()).toLocaleTimeString()} ${tick(m)}`;
    }
  });

  opInput.disabled=roomIsClosed;
  opForm.querySelector('button').disabled=roomIsClosed;
  btnFinish.disabled=false;

  btnOverlayDelete.onclick = () => archiveAndDelete(id);

  opInput.removeEventListener('input', onOpTyping);
  opInput.addEventListener('input', onOpTyping);

  window.scrollTo(0, document.body.scrollHeight);

  const roomEl = roomsList.querySelector(`.room[data-id="${id}"]`);
  if(roomEl) roomEl.classList.remove('unread');
}

function onOpTyping(){
  if (!currentRoom) return;
  try { set(ref(db,`chats/${currentRoom}/status/typing/admin`), !!opInput.value).catch(()=>{}); } catch (e) {}
}

/* ===== Enviar mensagem do operador ===== */
opForm.addEventListener('submit', async ev=>{
  ev.preventDefault();
  if(!currentRoom){ log.warn('Enviar: sem sala aberta'); return; }
  if(roomIsClosed){ alert('Atendimento encerrado. Clique em "Apagar conversa" ou reabra o chat.'); return; }
  const text=opInput.value.trim();
  if(!text) return;

  try{
    const data={ texto:text, autorRole:'agent', timestamp:serverTimestamp() };
    const msgRef=push(currentMsgsRef);
    await set(msgRef,data);
    await update(ref(db,`chats/${currentRoom}`), { lastMessage:text, lastMessageAt: Date.now(), lastMessageRole:'agent' });
    opInput.value='';
    set(ref(db,`chats/${currentRoom}/status/typing/admin`),false);
    scroll(opMessages);
    log.info('Mensagem enviada para', currentRoom);
  }catch(e){
    log.error('Falha ao enviar', e);
    alert('Falha ao enviar. Verifique sua conexão/permissões.');
  }
});

/* ===== Finalizar: marca fechado e cria msg de sistema ===== */
btnFinish.addEventListener('click',async ()=>{
  if(!currentRoom) return;
  try{
    const now = Date.now();
    await update(ref(db,`chats/${currentRoom}/status`),{closed:true, adminOnline:true});
    await push(ref(db,`chats/${currentRoom}/messages`),{
      autorRole:'system', autorName:'Sistema', texto:'Atendimento finalizado pelo operador.', timestamp: now
    });
    await update(ref(db,`chats/${currentRoom}`), { lastMessage:'Atendimento finalizado pelo operador.', lastMessageAt: now, lastMessageRole:'system' });
    toggleClosedUI(true);
  }catch(e){
    log.error('Falha ao finalizar', e);
  }
});

/* ===== Arquivar e apagar (ATÔMICO) ===== */
async function archiveAndDelete(id){
  try{
    const snap = await get(ref(db,`chats/${id}`));
    const chat = snap.val() || {};
    const msgsSnap = await get(ref(db,`chats/${id}/messages`));
    const messages = msgsSnap.val() || {};

    const archive = {
      meta:{
        id,
        userLabel: chat.userLabel||'',
        assunto: chat.assunto||'',
        userInfo: chat.userInfo||{},
        createdAt: chat.createdAt||null,
        endedAt: serverTimestamp(),
        lastMessage: chat.lastMessage||'',
        lastMessageAt: chat.lastMessageAt||null,
        lastMessageRole: chat.lastMessageRole||'',
        alerts: chat.alerts||{}
      },
      messages
    };

    const updates = {};
    updates[`/archives/${id}`] = archive;
    updates[`/chats/${id}`] = null;
    await update(ref(db), updates);

    toggleClosedUI(false);
    if(allChats[id]) delete allChats[id];
    renderRooms(filterInput.value||'');
    roomTitle.textContent='Selecione um chat';
    roomSub.textContent='—';
    opMessages.innerHTML='';
    opInput.disabled=true; opForm.querySelector('button').disabled=true; btnFinish.disabled=true;
    previousRoom = currentRoom;
    currentRoom=null;

    log.info('Chat arquivado e removido:', id);
  }catch(e){
    log.error('Falha ao arquivar/remover', e);
    alert('Não foi possível apagar a conversa. Confira as regras /archives no RTDB.');
  }
}

/* ===== Exportação XLSX ===== */
btnExport.addEventListener('click', async ()=>{
  try{
    await ensureXLSX();
    const rows = Object.entries(allChats).map(([id,c])=>({
      id,
      nome: c?.userInfo?.nome || c?.userLabel || '',
      contato: c?.userInfo?.contato || '',
      categoria: c?.userInfo?.categoria || '',
      assunto: c?.assunto || '',
      ultima_msg: c?.lastMessage || '',
      papel_ultima: c?.lastMessageRole || '',
      ultima_em: c?.lastMessageAt ? new Date(c.lastMessageAt).toLocaleString() : '',
      online: c?.status?.userOnline ? 'sim' : 'não',
      alertas: c?.alerts?.count || 0
    }));
    console.table(rows);
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'chats');
    XLSX.writeFile(wb, `chats_${new Date().toISOString().slice(0,10)}.xlsx`);
  }catch(e){
    log.error('Export XLSX', e);
    alert('Falha ao exportar XLSX. Tente novamente.');
  }
});

filterInput.addEventListener('input', ()=> renderRooms(filterInput.value||'') );

ensureOpSession();
startRoomsListener();
window.addEventListener('beforeunload', ()=>{ if(currentRoom) setAdminPresence(currentRoom, false); });
