// ============================================================
// RFQ Hub — landing page extras (loaded after app.js and saas.js)
// "Browse by province" tiles with LIVE open-RFQ counts (real data only),
// and the FAQ nav link. Wraps showLandingView rather than editing app.js.
// ============================================================

const LANDING_PROVINCES = [
  'Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'Limpopo',
  'Mpumalanga', 'Northern Cape', 'North West', 'Western Cape',
];

async function renderProvinceGrid() {
  const grid = document.getElementById('province-grid');
  if (!grid) return;
  const counts = Object.fromEntries(LANDING_PROVINCES.map(p => [p, 0]));
  try {
    // Same visibility rules as the public list: RLS only returns public,
    // released, non-draft RFQs to visitors.
    const { data, error } = await client
      .from('rfqs')
      .select('provinces')
      .eq('is_public', true)
      .eq('is_withdrawn', false)
      .gt('deadline', new Date().toISOString());
    if (error) throw error;
    (data || []).forEach(r => (Array.isArray(r.provinces) ? r.provinces : []).forEach(p => {
      if (p in counts) counts[p] += 1;
    }));
  } catch (err) {
    console.warn('Province counts unavailable:', err);
  }
  grid.innerHTML = LANDING_PROVINCES.map(p => {
    const n = counts[p];
    return `<button type="button" class="province-tile ${n ? 'has-open' : ''}" onclick="filterByProvince('${p}')">
      <span class="province-name">${p}</span>
      <span class="province-count">${n ? `${n} open RFQ${n === 1 ? '' : 's'}` : 'No open RFQs right now'}</span>
    </button>`;
  }).join('');
}

function filterByProvince(province) {
  const sel = document.getElementById('public-rfq-province-filter');
  if (sel) sel.value = province;
  if (typeof loadPublicRFQList === 'function') loadPublicRFQList();
  const list = document.getElementById('public-rfq-list');
  if (list) list.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function navGoFaq() {
  const landing = document.getElementById('landing-section');
  const onLanding = landing && landing.style.display !== 'none' && document.getElementById('public-view').style.display !== 'none';
  if (!onLanding) showLandingView();
  if (typeof closeMobileNav === 'function') { try { closeMobileNav(); } catch (_) { /* ignore */ } }
  setTimeout(() => {
    const el = document.getElementById('faq-section');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 60);
}

(function installLandingHooks() {
  const _show = showLandingView;
  showLandingView = function () {
    const r = _show.apply(this, arguments);
    renderProvinceGrid();
    return r;
  };
})();
