// operador.js v1.4
import { db, auth } from './app.js';
import {
  ref, onValue, onChildAdded, onChildChanged, push, update, serverTimestamp, get, set, remove, query, orderByChild
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";
import { signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";

const $ = s => document.querySelector(s);
const esc = s => String(s||'').replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const scroll = el => el && (el.scrollTop = el.scrollHeight);
const since = (ms)=>{const s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60);if(h>0)return`${h}h ${m%60}m`;if(m>0)return`${m}m ${s%60}s`;return`${s}s`;};
const tick = (m)=> `<span class="tick ${m.readAt?'seen':''}">${m.readAt?'✓✓':'✓✓'}</span>`;
const toast = (t)=>{let b=$('#opToast');if(!b){b=document.createElement('div');b.id='opToast';Object.assign(b.style,{position:'fixed',left:'14px',bottom:'14px',padding:'8px 10px',background:'#000a',color:'#fff',border:'1px solid #333',borderRadius:'6px',font:'12px monospace',zIndex:9999});document.body.appendChild(b);} b.textContent=t;};

let currentRoom=null, currentMsgsRef=null, allChats={}, waitInt=null;
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
async function ensureOpSession(){ try{ await signInAnonymously(auth); }catch(_){} }
onAuthStateChanged(auth, user=>{ if(!user) ensureOpSession(); });

function toggleClosedUI(closed){ opOverlay.style.display = closed ? 'flex' : 'none'; }

function renderRooms(filter=''){
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
    const badge = (c?.alerts?.count>0) ? `<span class="badge-alert">${c.alerts.count} alertas</span>` : '';
    return `
      <div class="room" data-id="${id}">
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

  // Primeiro GET para detectar erro e decidir fallback
  try{
    const first = await get(orderedQ);
    allChats = first.val() || {};
    renderRooms(filterInput.value||'');

    // live com a query ordenada
    onValue(orderedQ, s=>{
      allChats = s.val() || {};
      renderRooms(filterInput.value||'');
    });
    onChildChanged(ref(db,'chats'), s=>{
      allChats[s.key] = s.val();
      renderRooms(filterInput.value||'');
    });
    onChildAdded(ref(db,'chats'), s=>{
      allChats[s.key] = s.val();
      renderRooms(filterInput.value||'');
    });

  }catch(err){
    const msg = String(err?.message||err);
    console.error('Erro lendo /chats', err);

    if (msg.includes('Index not defined') || msg.includes('.indexOn')) {
      toast('Adicione ".indexOn": ["lastMessageAt"] em /chats nas regras. Usando fallback sem ordenação.');
      // Fallback sem ordenar (funciona mesmo sem índice)
      onValue(ref(db,'chats'), s=>{
        allChats = s.val() || {};
        renderRooms(filterInput.value||'');
      });
      onChildChanged(ref(db,'chats'), s=>{
        allChats[s.key] = s.val();
        renderRooms(filterInput.value||'');
      });
      onChildAdded(ref(db,'chats'), s=>{
        allChats[s.key] = s.val();
        renderRooms(filterInput.value||'');
      });
    } else {
      toast('Sem permissão para listar /chats. Verifique as regras do RTDB.');
    }
  }
}

const opTypingHandler = () => {
  if (!currentRoom) return;
  try { set(ref(db,`chats/${currentRoom}/status/typing/admin`), !!opInput.value).catch(()=>{}); } catch (e) {}
};

function openRoom(id){
  unsubs.forEach(fn => { try{ fn(); }catch(_){} }); unsubs = [];
  clearInterval(waitInt);

  currentRoom=id;
  const c = allChats[id] || {};
  roomTitle.textContent = c.userLabel || id;
  roomSub.textContent = c.assunto ? `Assunto: ${c.assunto}` : '—';
  opMessages.innerHTML='';

  currentMsgsRef=ref(db,`chats/${id}/messages`);
  update(ref(db,`chats/${id}/status`),{adminOnline:true}).catch(()=>{});

  unsubs.push(onValue(ref(db,`chats/${id}/status/userOnline`), s=>{
    const on = !!s.val();
    roomOnlineDot.classList.toggle('online', on);
    roomOnlineDot.classList.toggle('offline', !on);
    roomOnlineDot.innerHTML = `<span class="dot"></span> ${on?'online':'offline'}`;
  }));

  unsubs.push(onValue(ref(db,`chats/${id}/status/typing/user`), s=>{
    opTyping.textContent = s.val() ? 'Usuário está digitando…' : '';
  }));

  unsubs.push(onValue(ref(db,`chats/${id}/status/closed`), s=> toggleClosedUI(!!s.val()) ));

  unsubs.push(onChildAdded(ref(db,`chats/${id}/alerts/events`), ()=>{
    armarSom(); ding?.play?.().catch(()=>{});
    waitBadge.textContent='⚠ alerta recebido'; setTimeout(()=>waitBadge.textContent='aguardando —',4000);
  }));

  const updWait=()=>{
    const chat=allChats[id];
    waitBadge.textContent=(chat?.lastMessageRole==='user'&&chat?.lastMessageAt)
      ? `aguardando ${since(Date.now()-chat.lastMessageAt)}`
      : 'aguardando —';
  };
  updWait(); waitInt=setInterval(updWait,1000);

  unsubs.push(onChildAdded(currentMsgsRef, snap=>{
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
  }));

  unsubs.push(onChildChanged(currentMsgsRef, snap=>{
    const k=snap.key, m=snap.val();
    const el=document.getElementById(`msg-${k}`);
    if(!el) return;
    const mine=m.autorRole==='agent';
    if(mine){
      const meta=el.querySelector('.meta');
      if(meta) meta.innerHTML=`${new Date(m.timestamp||Date.now()).toLocaleTimeString()} ${tick(m)}`;
    }
  }));

  opInput.disabled=false;
  opForm.querySelector('button').disabled=false;
  btnFinish.disabled=false;
  btnOverlayDelete.onclick = () => handleDeleteAndReset(id);

  opInput.removeEventListener('input', opTypingHandler);
  opInput.addEventListener('input', opTypingHandler);
  window.scrollTo(0, document.body.scrollHeight);
}

opForm.addEventListener('submit', async ev=>{
  ev.preventDefault();
  if(!currentRoom) return;
  const text=opInput.value.trim();
  if(!text) return;
  const data={ texto:text, autorRole:'agent', timestamp:serverTimestamp() };
  const msgRef=push(currentMsgsRef);
  await set(msgRef,data);
  await update(ref(db,`chats/${currentRoom}`), { lastMessage:text, lastMessageAt: Date.now(), lastMessageRole:'agent' });
  opInput.value='';
  set(ref(db,`chats/${currentRoom}/status/typing/admin`),false);
  scroll(opMessages);
});

btnFinish.addEventListener('click',()=>{
  if(!currentRoom) return;
  update(ref(db,`chats/${currentRoom}/status`),{closed:true});
});

function handleDeleteAndReset(id){
  remove(ref(db,`chats/${id}`)).then(()=> location.reload() );
}

filterInput.addEventListener('input', ()=>{
  renderRooms(filterInput.value||'');
});

btnExport.addEventListener('click', ()=>{
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
    alerts: c?.alerts?.count || 0
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'chats');
  XLSX.writeFile(wb, `chats_${new Date().toISOString().slice(0,10)}.xlsx`);
});

ensureOpSession();
startRoomsListener();
