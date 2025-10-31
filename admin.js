// admin.js
import { db, auth, $, esc, scroll } from './app.js';
import {
  ref, onValue, onChildAdded, update, push, serverTimestamp, get
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";
import {
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";

const roomsList=$('#roomsList'), filterInput=$('#filterInput'), adminMessages=$('#adminMessages');
const roomTitle=$('#roomTitle'), roomStatusDot=$('#roomStatusDot'), roomStatusText=$('#roomStatusText');
const adminMsgForm=$('#adminMsgForm'), adminMsgInput=$('#adminMsgInput');
const btnReport=$('#btnReport'), btnCloseChat=$('#btnCloseChat');
const admLoginForm=$('#admLoginForm'), admEmail=$('#admEmail'), admPass=$('#admPass'), admGroup=$('#admGroup');
const admRegisterBtn=$('#admRegister'), btnAvailable=$('#btnAvailable'), admLogout=$('#admLogout');

let isAgent=false, agentUid=null, agentGroup='suporte';
let currentRoomId=null, currentMsgsRef=null;
let filterTerm='';

function setTyping(roomId, who, val){
  const p = ref(db, `chats/${roomId}/status/typing/${who}`);
  update(p, val? true : false);
}

function listenTyping(roomId, whoIsOther, targetEl, id='typingHintAdmin'){
  onValue(ref(db, `chats/${roomId}/status/typing/${whoIsOther}`), s=>{
    const v = !!s.val();
    let tip = document.getElementById(id);
    if(!tip){ tip=document.createElement('div'); tip.id=id; tip.className='center'; targetEl.appendChild(tip); }
    tip.textContent = v ? (whoIsOther==='admin' ? 'ADM está digitando…' : 'Usuário está digitando…') : '';
  });
}

// ---- Autenticação ADM ----
admRegisterBtn?.addEventListener('click', async ()=>{
  const email = (admEmail?.value||'').trim();
  const pass  = (admPass?.value||'');
  if(!email || !pass){ alert('Preencha email e senha.'); return; }
  try{
    const { user } = await createUserWithEmailAndPassword(auth, email, pass);
    const group = admGroup?.value || 'suporte';
    await update(ref(db, `roles/${user.uid}`), { group, isAdmin:true, name: email });
    await update(ref(db, `agents/${user.uid}`), { name: email, group, available:false, online:false, lastSeen: serverTimestamp() });
    alert('Agente cadastrado!');
  }catch(e){
    console.error('Cadastro ADM erro:', e);
    alert(`Falha no cadastro: ${e.code||''} ${e.message||''}`);
  }
});

// Login ADM (submit do form já dispara)
admLoginForm?.addEventListener('submit', async (e)=>{
  e.preventDefault();
  try{
    const email = (admEmail?.value||'').trim();
    const pass  = (admPass?.value||'');
    if(!email || !pass){ alert('Informe email e senha.'); return; }

    const { user } = await signInWithEmailAndPassword(auth, email, pass);
    isAgent=true; agentUid=user.uid;

    const roleSnap = await get(ref(db, `roles/${user.uid}`));
    const role = roleSnap.val() || { group: admGroup?.value || 'suporte' };
    agentGroup = role.group || 'suporte';

    await update(ref(db, `agents/${user.uid}`), {
      name: user.email, group: agentGroup, available:false, online:true, lastSeen: serverTimestamp()
    });

    initAdmin();
  }catch(err){
    console.error('Login ADM erro:', err);
    alert(`Falha no login: ${err.code||''} ${err.message||''}`);
  }
});

btnAvailable?.addEventListener('click', async ()=>{
  if(!agentUid) return;
  const snap = await get(ref(db, `agents/${agentUid}`));
  const cur = snap.val() || {};
  const toggled = !cur.available;
  await update(ref(db, `agents/${agentUid}`), { available: toggled, lastSeen: serverTimestamp() });
  btnAvailable.textContent = toggled ? 'marcar indisponível' : 'marcar disponível';
});

admLogout?.addEventListener('click', async ()=>{
  try{
    if(agentUid) await update(ref(db, `agents/${agentUid}`), { online:false, available:false, lastSeen: serverTimestamp() });
  }catch(_){}
  await signOut(auth).catch(()=>{});
  location.hash = '#/';
  location.reload();
});

// ---- Lista de salas do agente ----
function paintRooms(data){
  roomsList.innerHTML='';
  Object.entries(data).forEach(([id, c])=>{
    if(c.assignedTo?.uid !== agentUid) return; // só minhas
    const label = ((c.userLabel||id)+' • '+(c.assunto||'')).toLowerCase();
    if(filterTerm && !label.includes(filterTerm)) return;

    const li=document.createElement('li'); li.className='room'; li.dataset.id=id;
    const icon=document.createElement('span'); icon.className='dot '+(c.status?.userOnline?'online':''); li.appendChild(icon);
    const body=document.createElement('div'); body.style.flex='1';
    const title=document.createElement('div'); title.className='title'; title.textContent = (c.userLabel||id)+' • '+(c.assunto||'');
    const sub=document.createElement('div'); sub.className='sub';
    sub.textContent = c.lastMessage ? `${c.lastMessage} • ${new Date(c.lastMessageAt||Date.now()).toLocaleTimeString()}` : 'Sem mensagens';
    body.appendChild(title); body.appendChild(sub); li.appendChild(body);
    if(c.status?.queue){ const b=document.createElement('span'); b.className='badge'; b.textContent='Fila'; li.appendChild(b); }
    li.addEventListener('click', ()=> openRoom(id));
    roomsList.appendChild(li);
  });
}

function initAdmin(){
  // Observa todas as salas (poderia ser filtrado por índice em regras)
  onValue(ref(db, 'chats'), s=> paintRooms(s.val()||{}));
  filterInput?.addEventListener('input', ()=>{
    filterTerm = filterInput.value.trim().toLowerCase();
    // re-render será disparado pelo próximo onValue; para UX imediata, podemos refazer último snapshot:
    // (opcional) manter último snapshot em memória
  });
}

// ---- Abrir sala ----
async function openRoom(id){
  currentRoomId = id;
  roomTitle.textContent = id;
  adminMessages.innerHTML='';
  currentMsgsRef = ref(db, `chats/${id}/messages`);

  // presença
  onValue(ref(db, `chats/${id}/status/userOnline`), s=>{
    const online = !!s.val(); roomStatusDot.classList.toggle('online', online);
    roomStatusText.textContent = online ? 'Usuário online' : 'Usuário offline';
  });

  // mensagens
  onChildAdded(currentMsgsRef, (snap)=>{
    const k=snap.key, m=snap.val(); const div=document.createElement('div');
    const mine = m.autorRole==='agent' && m.autorUid===agentUid;
    div.className = `msg ${mine?'me':'adm'}`;
    div.innerHTML = `
      ${m.autorRole==='agent' ? `<div class="small">${esc(m.autorName||'Agente')}</div>` : ''}
      ${esc(m.texto||'')}
      <span class="time">${new Date(m.timestamp||Date.now()).toLocaleTimeString()} ${m.readAt?'• Lido':''}</span>`;
    adminMessages.appendChild(div); scroll(adminMessages);
    if(m.autorRole==='user') update(ref(db, `chats/${id}/messages/${k}`), { readAt: serverTimestamp() });
  });

  listenTyping(id, 'user', adminMessages, 'typingHintAdmin');

  adminMsgInput.disabled=false; adminMsgForm.querySelector('button').disabled=false;
  btnCloseChat.disabled=false;
}

let typingTimer=null;
adminMsgInput.addEventListener('input', ()=>{
  if(!currentRoomId) return;
  update(ref(db, `chats/${currentRoomId}/status/typing/admin`), true);
  clearTimeout(typingTimer);
  typingTimer = setTimeout(()=>update(ref(db, `chats/${currentRoomId}/status/typing/admin`), false), 1500);
});

adminMsgForm.addEventListener('submit', async (e)=>{
  e.preventDefault(); if(!currentMsgsRef) return;
  const text = adminMsgInput.value.trim(); if(!text) return;
  const autorName = (auth.currentUser?.email) || 'Agente';
  await push(currentMsgsRef, {
    autorUid: auth.currentUser?.uid || null,
    autorName, autorRole: 'agent', texto: text, timestamp: Date.now(), destinatario: "Usuário"
  });
  // atualizar resumo na lista
  await update(ref(db, `chats/${currentRoomId}`), { lastMessage: text, lastMessageAt: Date.now() });
  adminMsgInput.value='';
  update(ref(db, `chats/${currentRoomId}/status/typing/admin`), false);
});

// relatório XLSX
btnReport?.addEventListener('click', async ()=>{
  const snap = await get(ref(db, 'chats'));
  const all = snap.val() || {};
  const rows = [["Nome ADM","Nome user","Assunto","Grupo","Avaliação","RoomId","Data"]];
  Object.entries(all).forEach(([rid, c])=>{
    if (isAgent && agentUid && c.assignedTo?.uid !== agentUid) return;
    rows.push([
      c.assignedTo?.name || '',
      c.userLabel || '',
      c.assunto || '',
      c.assignedTo?.group || '',
      c.rating?.score || '',
      rid,
      new Date(c.createdAt || Date.now()).toISOString()
    ]);
  });
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Chats");
  const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([wbout], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'relatorio_chats.xlsx'; a.click();
  URL.revokeObjectURL(a.href);
});

// finalizar chat
btnCloseChat?.addEventListener('click', async ()=>{
  if(!currentRoomId) return;
  await update(ref(db, `chats/${currentRoomId}/status`), { closed:true });
  await push(currentMsgsRef, { autorName:"Sistema", autorRole:"agent", texto:"Atendimento finalizado pelo ADM.", timestamp:Date.now(), destinatario:"Usuário" });
});
window.addEventListener('keydown', (e)=>{ if(e.ctrlKey && e.key==='Enter' && currentRoomId){ btnCloseChat.click(); } });

// garantir estado do agente em caso de refresh/fechamento
onAuthStateChanged(auth, (u)=>{
  if(!u) return;
  agentUid = u.uid;
  update(ref(db, `agents/${agentUid}`), { online:true, lastSeen: serverTimestamp() }).catch(()=>{});
});
