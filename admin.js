// admin.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import {
  getDatabase, ref, onChildAdded, onValue, push, serverTimestamp, update, get, child
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

const roomsList  = document.getElementById('roomsList');
const filterInput= document.getElementById('filterInput');
const adminMessages = document.getElementById('adminMessages');
const roomTitle  = document.getElementById('roomTitle');
const roomStatusDot = document.getElementById('roomStatusDot');
const roomStatusText= document.getElementById('roomStatusText');
const adminMsgForm  = document.getElementById('adminMsgForm');
const adminMsgInput = document.getElementById('adminMsgInput');
const ding = document.getElementById('ding');

let currentRoomId = null;
let currentMsgsRef = null;

// ----------------------------------------------------
// Funções utilitárias
// ----------------------------------------------------
function fmtTime(ts){
  const d = new Date(Number(ts || Date.now()));
  return d.toLocaleString();
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, m => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]
  ));
}

function renderRoomLi(id, data){
  const li = document.createElement('li');
  li.className = 'room';
  li.dataset.id = id;

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = data.userLabel || id;

  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = data.lastMessage
    ? `${data.lastMessage} • ${new Date(data.lastMessageAt || Date.now()).toLocaleTimeString()}`
    : 'Sem mensagens';

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = '0';
  badge.style.display = 'none';

  li.appendChild(title);
  li.appendChild(sub);
  li.appendChild(badge);
  li.addEventListener('click', ()=> openRoom(id));

  return li;
}

function incrementBadge(li){
  const badge = li.querySelector('.badge');
  const n = Number(badge.textContent || '0') + 1;
  badge.textContent = String(n);
  badge.style.display = 'inline-block';
}

function clearBadge(li){
  const badge = li.querySelector('.badge');
  if(badge){
    badge.textContent = '0';
    badge.style.display = 'none';
  }
}

// ----------------------------------------------------
// Listar conversas em tempo real
// ----------------------------------------------------
onChildAdded(ref(db, 'chats'), (snap)=>{
  const id = snap.key;
  const data = snap.val() || {};
  const li = renderRoomLi(id, data);
  roomsList.appendChild(li);

  // Atualizações em tempo real do status / últimas mensagens
  onValue(ref(db, `chats/${id}`), (s)=>{
    const d = s.val() || {};
    li.querySelector('.sub').textContent = d.lastMessage
      ? `${d.lastMessage} • ${new Date(d.lastMessageAt||Date.now()).toLocaleTimeString()}`
      : 'Sem mensagens';

    // Notificação sonora se nova mensagem destinada ao ADM
    if(currentRoomId !== id && d.lastMessage && d.lastMessageDest === "ADM"){
      incrementBadge(li);
      try { ding.currentTime = 0; ding.play(); } catch {}
    }
  });
});

// ----------------------------------------------------
// Filtro de conversas
// ----------------------------------------------------
filterInput.addEventListener('input', ()=>{
  const q = filterInput.value.toLowerCase();
  [...roomsList.children].forEach(li=>{
    const t = (li.querySelector('.title').textContent + ' ' +
               li.querySelector('.sub').textContent).toLowerCase();
    li.style.display = t.includes(q) ? '' : 'none';
  });
});

// ----------------------------------------------------
// Abrir sala de chat específica
// ----------------------------------------------------
async function openRoom(id){
  currentRoomId = id;
  adminMessages.innerHTML = '';
  roomTitle.textContent = 'Carregando...';
  adminMsgInput.disabled = true;
  adminMsgForm.querySelector('button').disabled = true;

  const roomSnap = await get(child(ref(db), `chats/${id}`));
  const data = roomSnap.val() || {};
  roomTitle.textContent = data.userLabel || id;

  // Atualizar status do usuário
  onValue(ref(db, `chats/${id}/status`), (s)=>{
    const st = s.val() || {};
    roomStatusDot.classList.toggle('online', !!st.userOnline);
    roomStatusText.textContent = st.userOnline
      ? 'Usuário online'
      : (st.userLastSeen
         ? `Último acesso: ${fmtTime(st.userLastSeen)}`
         : 'Usuário offline');
  });

  // Limpar badge da conversa aberta
  const li = [...roomsList.children].find(x => x.dataset.id === id);
  if(li) clearBadge(li);

  // Marcar ADM online
  update(ref(db, `chats/${id}/status`), { adminOnline: true, adminLastSeen: serverTimestamp() });

  // Escutar mensagens da sala
  const msgsRef = ref(db, `chats/${id}/messages`);
  currentMsgsRef = msgsRef;

  onChildAdded(msgsRef, (snap)=>{
    const m = snap.val();
    renderMsg(m);
    adminMessages.scrollTop = adminMessages.scrollHeight;
  });

  adminMsgInput.disabled = false;
  adminMsgForm.querySelector('button').disabled = false;
}

// ----------------------------------------------------
// Renderizar mensagens
// ----------------------------------------------------
function renderMsg({ autor, texto, timestamp, destinatario }){
  const isToUser = destinatario === "Usuário";
  const bubble = document.createElement('div');
  bubble.className = `msg ${isToUser ? 'adm' : 'me'}`;
  bubble.innerHTML = `${escapeHtml(texto)}<span class="time">${fmtTime(timestamp)}</span>`;
  adminMessages.appendChild(bubble);
}

// ----------------------------------------------------
// Enviar mensagens do ADM
// ----------------------------------------------------
adminMsgForm.addEventListener('submit', (e)=>{
  e.preventDefault();
  const text = adminMsgInput.value.trim();
  if(!text || !currentRoomId || !currentMsgsRef) return;

  push(currentMsgsRef, {
    autor: "ADM",
    texto: text,
    timestamp: Date.now(),
    destinatario: "Usuário"
  });

  update(ref(db, `chats/${currentRoomId}`), {
    lastMessage: text,
    lastMessageAt: serverTimestamp(),
    lastMessageDest: "Usuário",
    "status/adminLastSeen": serverTimestamp()
  });

  adminMsgInput.value = '';
  adminMessages.scrollTop = adminMessages.scrollHeight;
});

// ----------------------------------------------------
// Ao fechar a aba, marcar ADM offline
// ----------------------------------------------------
window.addEventListener('beforeunload', ()=>{
  if(currentRoomId){
    update(ref(db, `chats/${currentRoomId}/status`), {
      adminOnline: false,
      adminLastSeen: serverTimestamp()
    });
  }
});
