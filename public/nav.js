// Shared navigation injection
(function(){
  const LINKS = [
    { href: 'index.html', label: 'Time Logger' },
    { href: 'ai-agent.html', label: 'AI Agent' },
    { href: 'debug.html', label: 'Debug' },
    { href: 'config.html', label: 'Config' },
    { href: 'daily-notes.html', label: 'Daily Notes (AI)' }
  ];
  const path = window.location.pathname.split('/').pop() || 'index.html';
  const nav = document.createElement('div');
  nav.className = 'navigation';
  nav.innerHTML = LINKS.map(l => `<a href="${l.href}" ${l.href===path? 'class="active"':''}>${l.label}</a>`).join('');
  // Insert at top of body if not already there
  const first = document.body.firstElementChild;
  if (first && first.classList && first.classList.contains('navigation')) {
    first.replaceWith(nav);
  } else {
    document.body.insertBefore(nav, first);
  }
  // Inject base styles once
  if (!document.getElementById('shared-nav-styles')) {
    const style = document.createElement('style');
    style.id = 'shared-nav-styles';
    style.textContent = `.navigation{background:#fff;padding:15px 25px;border-radius:8px;margin-bottom:20px;box-shadow:0 2px 4px rgba(0,0,0,.1);} .navigation a{color:#0052cc;text-decoration:none;margin-right:20px;font-weight:500;} .navigation a:hover{text-decoration:underline;} .navigation a.active{color:#0747a6;border-bottom:2px solid #0052cc;padding-bottom:2px;}`;
    document.head.appendChild(style);
  }
})();