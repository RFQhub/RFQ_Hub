// ============================================================
// RFQ Hub — SaaS module (contractor subscriptions via PayFast)
// Loaded after app.js. Adds: public pricing + 30-day trial sign-up,
// the contractor "Subscription" tab and banner, and the platform-admin
// "Subscriptions & Plans" tab. Hooks into app.js by wrapping a few of its
// global functions rather than editing them, so app.js stays close to the
// original RFQ Hub code.
// ============================================================

const SAAS = {
  plans: [],
  plansLoaded: false,
  cycle: 'monthly',
  mySub: null,
  superRows: [],
};

const SUB_STATUS = {
  trialing:        { label: 'Free trial',        color: '#0F5E8C', bg: '#E3F1FA' },
  active:          { label: 'Active',            color: '#2E6B4F', bg: '#E8F3EC' },
  past_due:        { label: 'Payment failed',    color: '#9A5B00', bg: '#FFF4E0' },
  cancelled:       { label: 'Cancelled',         color: '#6B7280', bg: '#F1F3F5' },
  pending_payment: { label: 'Awaiting payment',  color: '#9A5B00', bg: '#FFF4E0' },
  comped:          { label: 'Complimentary',     color: '#5B3FA0', bg: '#F0EBFA' },
  suspended:       { label: 'Suspended',         color: '#B23B2E', bg: '#FDECEA' },
};

const saasEsc = (v) => (typeof escapeHtmlClient === 'function' ? escapeHtmlClient(v) : String(v ?? ''));
const rands = (n) => 'R' + Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const saasDate = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d) ? '—' : d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
};
const daysUntil = (v) => (v ? Math.ceil((new Date(v) - new Date()) / 86400000) : null);
const statusPill = (status) => {
  const s = SUB_STATUS[status] || { label: status || '—', color: '#6B7280', bg: '#F1F3F5' };
  return `<span class="sub-pill" style="color:${s.color}; background:${s.bg};">${s.label}</span>`;
};

// Mirrors public.company_subscription_active() so the UI and DB agree.
function subscriptionIsActive(sub) {
  if (!sub) return false;
  if (sub.status === 'comped') return true;
  if (sub.status === 'trialing') return !!sub.trial_ends_at && new Date(sub.trial_ends_at) > new Date();
  if (['active', 'past_due', 'cancelled'].includes(sub.status)) {
    return !!sub.current_period_end && new Date(sub.current_period_end).getTime() > Date.now() - 3 * 86400000;
  }
  return false;
}

function planPrice(plan, cycle) {
  return cycle === 'annual' ? plan.price_annual : plan.price_monthly;
}

async function loadPlans(force) {
  if (SAAS.plansLoaded && !force) return SAAS.plans;
  try {
    const { data, error } = await client.from('subscription_plans').select('*').eq('is_active', true).order('sort_order');
    if (error) throw error;
    SAAS.plans = data || [];
    SAAS.plansLoaded = true;
  } catch (err) {
    console.error('Could not load plans:', err);
    SAAS.plans = [];
  }
  return SAAS.plans;
}

// ── Public pricing ───────────────────────────────────────────

function planCardHtml(plan, opts = {}) {
  const cycle = opts.cycle || 'monthly';
  const price = planPrice(plan, cycle);
  const features = Array.isArray(plan.features) ? plan.features : [];
  const limit = plan.max_rfqs_per_month ? `Up to <strong>${plan.max_rfqs_per_month}</strong> RFQs per month` : '<strong>Unlimited</strong> RFQs';
  return `
    <div class="pricing-card ${plan.is_featured ? 'featured' : ''} ${opts.current ? 'current' : ''}">
      ${plan.is_featured ? '<div class="pricing-badge">Most popular</div>' : ''}
      <h3>${saasEsc(plan.name)}</h3>
      ${plan.tagline && !/^\[.*\]$/.test(plan.tagline) ? `<p class="pricing-tagline">${saasEsc(plan.tagline)}</p>` : ''}
      <div class="pricing-price">${price ? rands(price) : '—'}<span>/${cycle === 'annual' ? 'year' : 'month'}</span></div>
      <p class="pricing-limit">${limit}</p>
      <ul class="pricing-features">${features.map(f => `<li>${saasEsc(f)}</li>`).join('')}</ul>
      ${opts.buttonHtml || ''}
    </div>`;
}

async function renderPricing() {
  const grid = document.getElementById('pricing-grid');
  if (!grid) return;
  const plans = await loadPlans();
  const hasAnnual = plans.some(p => Number(p.price_annual) > 0);
  const toggle = document.getElementById('pricing-cycle-toggle');
  if (toggle) toggle.style.display = hasAnnual ? 'inline-flex' : 'none';
  if (!hasAnnual) SAAS.cycle = 'monthly';
  if (!plans.length) {
    grid.innerHTML = `<p style="text-align:center; color:var(--border);">Plans are being finalised. Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> to get started.</p>`;
    return;
  }
  grid.innerHTML = plans
    .filter(p => Number(planPrice(p, SAAS.cycle)) > 0)
    .map(p => planCardHtml(p, {
      cycle: SAAS.cycle,
      buttonHtml: `<button type="button" class="btn ${p.is_featured ? 'gold' : 'navy'} pricing-btn" onclick="openContractorSignup('${p.id}')">Start 30-day free trial</button>`,
    })).join('');
}

function setPricingCycle(cycle) {
  SAAS.cycle = cycle === 'annual' ? 'annual' : 'monthly';
  document.querySelectorAll('#pricing-cycle-toggle button').forEach(b => b.classList.toggle('active', b.dataset.cycle === SAAS.cycle));
  renderPricing();
}

function navGoPricing() {
  const landing = document.getElementById('landing-section');
  const onLanding = landing && landing.style.display !== 'none' && document.getElementById('public-view').style.display !== 'none';
  if (!onLanding) showLandingView();
  if (typeof closeMobileNav === 'function') { try { closeMobileNav(); } catch (_) { /* ignore */ } }
  setTimeout(() => {
    const el = document.getElementById('pricing-section');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 60);
}

// ── Contractor sign-up (30-day trial) ────────────────────────

function ensureSignupModal() {
  if (document.getElementById('contractor-signup-modal')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
  <div id="contractor-signup-modal" class="modal" style="display:none;">
    <div class="modal-content" style="max-width:560px;">
      <div class="modal-head">
        <h3>Start your 30-day free trial</h3>
        <button class="drawer-close" onclick="closeModal('contractor-signup-modal')">✕</button>
      </div>
      <div class="modal-body" id="contractor-signup-body">
        <form id="contractor-signup-form" style="display:flex; flex-direction:column; gap:14px;">
          <p style="margin:0; font-size:14px; color:var(--border);">Publish RFQs and receive quotations online. No card needed: you'll choose how to pay before the trial ends.</p>
          <div>
            <label style="font-weight:bold;">Company name *</label>
            <input type="text" id="signup-company" required maxlength="150" autocomplete="organization" style="width:100%;">
          </div>
          <div class="form-grid-2">
            <div>
              <label style="font-weight:bold;">Your full name *</label>
              <input type="text" id="signup-name" required maxlength="120" autocomplete="name" style="width:100%;">
            </div>
            <div>
              <label style="font-weight:bold;">Mobile number</label>
              <input type="tel" id="signup-phone" maxlength="20" autocomplete="tel" placeholder="e.g. 082 123 4567" style="width:100%;">
            </div>
          </div>
          <div>
            <label style="font-weight:bold;">Work email *</label>
            <input type="email" id="signup-email" required autocomplete="email" style="width:100%;">
            <p style="margin:4px 0 0 0; font-size:12px; color:var(--border);">This becomes your login. We'll email you a link to set your password.</p>
          </div>
          <div>
            <label style="font-weight:bold;">Plan *</label>
            <select id="signup-plan" required style="width:100%;"></select>
            <p style="margin:4px 0 0 0; font-size:12px; color:var(--border);">You can change plan at any time.</p>
          </div>
          <input type="text" id="signup-website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute; left:-9999px; width:1px; height:1px; opacity:0;">
          <label style="display:flex; gap:8px; align-items:flex-start; font-weight:normal; font-size:13px; cursor:pointer;">
            <input type="checkbox" id="signup-terms" style="margin-top:3px;">
            <span>I accept the <a href="#" onclick="navGoTerms(); return false;">Terms &amp; Conditions</a> and the <a href="#" onclick="openModal('popia-modal'); return false;">Privacy Notice</a>, and I'm authorised to sign up on behalf of this company.</span>
          </label>
          <button type="submit" id="signup-submit" class="btn gold" style="padding:12px;">Start Free Trial</button>
          <p style="margin:0; text-align:center; font-size:13px; color:var(--border);">Already have an account? <a href="#" onclick="closeModal('contractor-signup-modal'); showLoginForm(); return false;" style="font-weight:600;">Sign in</a></p>
        </form>
      </div>
    </div>
  </div>`;
  document.body.appendChild(wrap.firstElementChild);
  document.getElementById('contractor-signup-form').addEventListener('submit', handleContractorSignup);
}

async function openContractorSignup(planId) {
  ensureSignupModal();
  const plans = await loadPlans();
  const sel = document.getElementById('signup-plan');
  sel.innerHTML = plans.filter(p => Number(p.price_monthly) > 0).map(p =>
    `<option value="${p.id}">${saasEsc(p.name)}: ${rands(p.price_monthly)}/month${p.max_rfqs_per_month ? ` (up to ${p.max_rfqs_per_month} RFQs/month)` : ''}</option>`).join('');
  const fallback = plans.find(p => p.is_featured) || plans[0];
  sel.value = planId || (fallback && fallback.id) || '';
  openModal('contractor-signup-modal');
}

async function handleContractorSignup(e) {
  e.preventDefault();
  const btn = document.getElementById('signup-submit');
  const payload = {
    companyName: document.getElementById('signup-company').value.trim(),
    ownerName: document.getElementById('signup-name').value.trim(),
    phone: document.getElementById('signup-phone').value.trim(),
    email: document.getElementById('signup-email').value.trim(),
    planId: document.getElementById('signup-plan').value,
    acceptTerms: document.getElementById('signup-terms').checked,
    website: document.getElementById('signup-website').value,
  };
  if (!payload.acceptTerms) { showToast('Please accept the Terms & Conditions and Privacy Notice', 'error'); return; }
  btn.disabled = true; btn.textContent = 'Setting up your account…';
  try {
    const res = await callPublicEdgeFunction('contractor-signup', payload);
    const ends = res.trialEndsAt ? saasDate(res.trialEndsAt) : '';
    document.getElementById('contractor-signup-body').innerHTML = `
      <div style="text-align:center; padding:10px 0;">
        <div style="font-size:42px;">📧</div>
        <h3 style="margin:8px 0;">Check your email</h3>
        <p style="color:var(--ink);">We've sent <strong>${saasEsc(payload.email)}</strong> a link to set your password. Open it on this device to go straight to your dashboard.</p>
        ${ends ? `<p style="color:var(--border); font-size:14px;">Your free trial runs until <strong>${ends}</strong>.</p>` : ''}
        <p style="color:var(--border); font-size:13px;">Nothing arrived after a few minutes? Check your spam folder, or email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
        <button type="button" class="btn secondary" onclick="closeModal('contractor-signup-modal')">Close</button>
      </div>`;
  } catch (err) {
    showToast('❌ ' + err.message, 'error');
    btn.disabled = false; btn.textContent = 'Start Free Trial';
  }
}

// ── Contractor dashboard: banner + Subscription tab ──────────

async function loadMySubscription() {
  if (!currentCompany) { SAAS.mySub = null; return null; }
  try {
    const { data, error } = await client.from('company_subscriptions')
      .select('*, subscription_plans(*)').eq('company_id', currentCompany.id).maybeSingle();
    if (error) throw error;
    SAAS.mySub = data;
  } catch (err) {
    console.error('Could not load subscription:', err);
    SAAS.mySub = null;
  }
  return SAAS.mySub;
}

function renderSubscriptionBanner() {
  const el = document.getElementById('subscription-banner');
  if (!el) return;
  const sub = SAAS.mySub;
  if (!sub || isSuperAdmin && !currentCompany) { el.style.display = 'none'; return; }
  const go = `<a href="#" onclick="openSubscriptionTab(); return false;">`;
  let html = '', tone = 'info';
  const active = subscriptionIsActive(sub);
  if (sub.status === 'trialing' && active) {
    const d = daysUntil(sub.trial_ends_at);
    if (d > 7) { el.style.display = 'none'; return; }
    tone = d <= 3 ? 'warn' : 'info';
    html = `⏳ Your free trial ends in <strong>${d} day${d === 1 ? '' : 's'}</strong> (${saasDate(sub.trial_ends_at)}). ${go}Subscribe now</a> to keep publishing. Your paid month starts when the trial ends.`;
  } else if (sub.status === 'past_due') {
    tone = 'warn';
    html = `⚠️ PayFast couldn't take your latest payment. ${go}Update your payment</a> to avoid interruption.`;
  } else if (sub.status === 'cancelled' && active) {
    html = `Your subscription is cancelled and stays active until <strong>${saasDate(sub.current_period_end)}</strong>. ${go}Resubscribe</a>`;
  } else if (sub.status === 'suspended') {
    tone = 'error';
    html = `⛔ This account is suspended. Please contact <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.`;
  } else if (!active) {
    tone = 'error';
    html = sub.status === 'trialing'
      ? `Your free trial has ended. You can still create and save RFQs, but you'll need to ${go}choose a plan</a> to publish them.`
      : `Your subscription isn't active. You can still create and save RFQs, but you'll need to ${go}subscribe</a> to publish them.`;
  } else {
    el.style.display = 'none'; return;
  }
  el.className = `subscription-banner ${tone}`;
  el.innerHTML = html;
  el.style.display = 'block';
}

function openSubscriptionTab() {
  switchAdminTab('subscription', document.getElementById('subscription-tab-btn'));
  const el = document.getElementById('subscription-tab');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function renderSubscriptionTab() {
  const sumEl = document.getElementById('subscription-summary');
  const optEl = document.getElementById('subscription-plan-options');
  const payEl = document.getElementById('subscription-payments');
  if (!sumEl) return;
  sumEl.innerHTML = '<p style="color:var(--border);">Loading…</p>';
  const [sub, plans] = await Promise.all([loadMySubscription(), loadPlans()]);
  renderSubscriptionBanner();
  if (!sub) { sumEl.innerHTML = '<p>No subscription record found. Please contact support.</p>'; return; }

  const isOwner = currentMemberRole === 'owner';
  const plan = sub.subscription_plans;
  let used = null;
  try {
    const { data } = await client.rpc('company_rfqs_this_month', { p_company_id: currentCompany.id });
    used = typeof data === 'number' ? data : null;
  } catch (_) { /* ignore */ }
  const limit = sub.status === 'comped' ? null : (plan && plan.max_rfqs_per_month);
  const pct = limit && used !== null ? Math.min(100, Math.round((used / limit) * 100)) : null;

  let dateLine = '';
  if (sub.status === 'trialing') dateLine = `Trial ends <strong>${saasDate(sub.trial_ends_at)}</strong> (${Math.max(0, daysUntil(sub.trial_ends_at))} days left)`;
  else if (sub.status === 'comped') dateLine = 'No billing. Complimentary access.';
  else if (sub.current_period_end) dateLine = `${sub.status === 'cancelled' ? 'Access until' : (sub.status === 'active' ? 'Paid up until · renews' : 'Paid up until')} <strong>${saasDate(sub.current_period_end)}</strong>`;

  sumEl.innerHTML = `
    <div class="sub-summary">
      <div>
        <div class="sub-summary-label">Plan</div>
        <div class="sub-summary-value">${plan ? saasEsc(plan.name) : 'None selected'} ${statusPill(sub.status)}</div>
        <div style="font-size:13px; color:var(--border); margin-top:4px;">${dateLine}</div>
        ${sub.amount && sub.status !== 'trialing' && sub.status !== 'comped' ? `<div style="font-size:13px; color:var(--border);">${rands(sub.amount)} per ${sub.billing_cycle === 'annual' ? 'year' : 'month'} via PayFast</div>` : ''}
      </div>
      <div>
        <div class="sub-summary-label">RFQs published this month</div>
        <div class="sub-summary-value">${used === null ? '—' : used}${limit ? ` <span style="font-weight:normal; color:var(--border);">of ${limit}</span>` : ' <span style="font-weight:normal; color:var(--border);">(no limit)</span>'}</div>
        ${pct !== null ? `<div class="sub-meter"><div style="width:${pct}%; background:${pct >= 100 ? '#B23B2E' : pct >= 80 ? '#F57C00' : '#2E6B4F'};"></div></div>` : ''}
        <div style="font-size:12px; color:var(--border); margin-top:4px;">Resets on the 1st of each month. Drafts don't count.</div>
      </div>
    </div>
    ${!isOwner ? `<p style="margin:16px 0 0 0; font-size:13px; color:var(--border);">Only your company's owner can change the plan or payment details.</p>` : ''}
    ${isOwner && sub.payfast_token && sub.status !== 'cancelled' && sub.status !== 'comped'
      ? `<div style="margin-top:18px;"><button type="button" class="btn secondary" onclick="cancelMySubscription()">Cancel subscription</button></div>` : ''}`;

  // Plan options
  const card = document.getElementById('subscription-plans-card');
  if (sub.status === 'comped' || sub.status === 'suspended') {
    if (card) card.style.display = 'none';
  } else {
    if (card) card.style.display = '';
    const billable = plans.filter(p => Number(p.price_monthly) > 0);
    optEl.innerHTML = billable.map(p => {
      const isCurrentPaid = sub.plan_id === p.id && sub.status === 'active' && !!sub.payfast_token && !sub.cancel_at_period_end;
      let btn = '';
      if (!isOwner) btn = '';
      else if (isCurrentPaid) btn = `<button type="button" class="btn secondary pricing-btn" disabled>Current plan</button>`;
      else {
        const verb = (sub.status === 'active' && sub.payfast_token && !sub.cancel_at_period_end) ? 'Switch to' : 'Subscribe to';
        btn = `<button type="button" class="btn ${p.is_featured ? 'gold' : 'navy'} pricing-btn" onclick="startCheckout('${p.id}', 'monthly')">${verb} ${saasEsc(p.name)}: ${rands(p.price_monthly)}/month</button>`;
        if (Number(p.price_annual) > 0) {
          btn += `<button type="button" class="btn secondary pricing-btn" style="margin-top:8px;" onclick="startCheckout('${p.id}', 'annual')">or ${rands(p.price_annual)}/year</button>`;
        }
      }
      return planCardHtml(p, { cycle: 'monthly', current: sub.plan_id === p.id, buttonHtml: btn });
    }).join('') || '<p style="color:var(--border);">No plans available right now.</p>';
  }

  // Payment history
  try {
    const { data: pays, error } = await client.from('subscription_payments')
      .select('created_at, item_name, amount_gross, pf_payment_id, period_end, payment_status')
      .eq('company_id', currentCompany.id).order('created_at', { ascending: false }).limit(24);
    if (error) throw error;
    payEl.innerHTML = (pays && pays.length) ? `
      <div style="overflow-x:auto;"><table class="saas-table">
        <thead><tr><th>Date</th><th>Description</th><th style="text-align:right;">Amount</th><th>PayFast ref</th><th>Covers until</th></tr></thead>
        <tbody>${pays.map(p => `<tr><td>${saasDate(p.created_at)}</td><td>${saasEsc(p.item_name || '')}</td><td style="text-align:right;">${rands(p.amount_gross)}</td><td>${saasEsc(p.pf_payment_id || '')}</td><td>${saasDate(p.period_end)}</td></tr>`).join('')}</tbody>
      </table></div>
      <p style="font-size:12px; color:var(--border); margin:10px 0 0 0;">PayFast also emails a receipt for every payment.</p>`
      : '<p style="color:var(--border);">No payments yet.</p>';
  } catch (err) {
    payEl.innerHTML = '<p style="color:#B23B2E;">Could not load payment history.</p>';
  }
}

async function startCheckout(planId, billingCycle) {
  const sub = SAAS.mySub;
  if (sub && sub.status === 'active' && sub.payfast_token && !sub.cancel_at_period_end) {
    if (!confirm('Switch plans? You\'ll set up the new plan on PayFast now. Your current PayFast subscription is cancelled automatically once the new one is confirmed, and the new payment extends your paid-up date.')) return;
  }
  try {
    showToast('Taking you to PayFast…', 'info');
    const res = await callEdgeFunction('billing', { action: 'checkout', planId, billingCycle });
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = res.processUrl;
    form.style.display = 'none';
    (res.fields || []).forEach(([name, value]) => {
      const input = document.createElement('input');
      input.type = 'hidden'; input.name = name; input.value = value;
      form.appendChild(input);
    });
    document.body.appendChild(form);
    form.submit();
  } catch (err) {
    showToast('❌ ' + err.message, 'error');
  }
}

async function cancelMySubscription() {
  const sub = SAAS.mySub;
  const until = sub && sub.current_period_end ? saasDate(sub.current_period_end) : 'the end of your paid period';
  if (!confirm(`Cancel your RFQ Hub subscription?\n\nPayFast will stop billing you. You can keep publishing until ${until}, and your RFQs, submissions and documents stay on the platform.`)) return;
  try {
    await callEdgeFunction('billing', { action: 'cancel' });
    showToast(`✅ Subscription cancelled. Access continues until ${until}.`, 'success');
    renderSubscriptionTab();
  } catch (err) {
    showToast('❌ ' + err.message, 'error');
  }
}

// After PayFast returns the browser: the ITN may land a few seconds later.
async function waitForActivation() {
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 2500));
    if (!currentCompany) continue;
    const sub = await loadMySubscription();
    if (sub && sub.status === 'active' && sub.current_period_end && new Date(sub.current_period_end) > new Date()) {
      renderSubscriptionBanner();
      const tab = document.getElementById('subscription-tab');
      if (tab && tab.style.display !== 'none') renderSubscriptionTab();
      showToast('✅ Payment confirmed. Your subscription is active.', 'success');
      return;
    }
  }
  showToast('Payment received by PayFast. Activation can take a minute; refresh the Subscription tab shortly.', 'info');
}

// ── Platform admin: Subscriptions & Plans ────────────────────

async function loadSuperSubscriptions() {
  const listEl = document.getElementById('super-subs-list');
  if (!listEl) return;
  listEl.innerHTML = '<p style="color:var(--border);">Loading…</p>';
  try {
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const [{ data: companies, error: cErr }, { data: subs, error: sErr }, { data: plans }, { data: rfqs }] = await Promise.all([
      client.from('companies').select('id, name, contact_email, created_at'),
      client.from('company_subscriptions').select('*'),
      client.from('subscription_plans').select('*').order('sort_order'),
      client.from('rfqs').select('company_id, released_at, created_at, is_released').eq('is_released', true),
    ]);
    if (cErr) throw cErr;
    if (sErr) throw sErr;
    const subBy = new Map((subs || []).map(s => [s.company_id, s]));
    const planBy = new Map((plans || []).map(p => [p.id, p]));
    const monthCount = new Map();
    (rfqs || []).forEach(r => {
      const when = new Date(r.released_at || r.created_at);
      if (when >= monthStart) monthCount.set(r.company_id, (monthCount.get(r.company_id) || 0) + 1);
    });
    SAAS.allPlans = plans || [];
    SAAS.superRows = (companies || []).map(c => ({
      company: c,
      sub: subBy.get(c.id) || { status: 'pending_payment' },
      plan: planBy.get((subBy.get(c.id) || {}).plan_id) || null,
      rfqsThisMonth: monthCount.get(c.id) || 0,
    })).sort((a, b) => new Date(b.company.created_at) - new Date(a.company.created_at));
    renderSuperSubscriptions();
    renderSuperPlans();
    loadItnLog();
  } catch (err) {
    console.error(err);
    listEl.innerHTML = `<p style="color:#B23B2E;">Could not load subscriptions: ${saasEsc(err.message)}</p>`;
  }
}

function renderSuperSubscriptions() {
  const listEl = document.getElementById('super-subs-list');
  if (!listEl) return;
  const term = (document.getElementById('super-subs-search')?.value || '').trim().toLowerCase();
  const status = document.getElementById('super-subs-status-filter')?.value || '';
  const rows = SAAS.superRows.filter(r => {
    if (status && r.sub.status !== status) return false;
    if (!term) return true;
    return [r.company.name, r.company.contact_email, r.sub.owner_email, r.sub.owner_name].filter(Boolean).some(v => v.toLowerCase().includes(term));
  });

  // Headline numbers (from real data only)
  const counts = {};
  let mrr = 0;
  SAAS.superRows.forEach(r => {
    counts[r.sub.status] = (counts[r.sub.status] || 0) + 1;
    if (r.sub.status === 'active' && r.sub.amount) mrr += r.sub.billing_cycle === 'annual' ? Number(r.sub.amount) / 12 : Number(r.sub.amount);
  });
  const statsEl = document.getElementById('super-subs-stats');
  if (statsEl) statsEl.innerHTML = `
    <div><strong>${counts.active || 0}</strong><span>paying</span></div>
    <div><strong>${counts.trialing || 0}</strong><span>on trial</span></div>
    <div><strong>${(counts.past_due || 0)}</strong><span>payment failed</span></div>
    <div><strong>${rands(Math.round(mrr))}</strong><span>monthly recurring</span></div>`;

  if (!rows.length) { listEl.innerHTML = '<p style="text-align:center; color:var(--border); padding:30px 0;">No companies match.</p>'; return; }
  const canEdit = typeof canEditSection === 'function' ? canEditSection('billing') : true;
  listEl.innerHTML = `
    <div style="overflow-x:auto;"><table class="saas-table">
      <thead><tr><th>Company</th><th>Owner</th><th>Plan</th><th>Status</th><th>Trial / paid until</th><th style="text-align:right;">RFQs this month</th><th></th></tr></thead>
      <tbody>${rows.map(r => {
        const until = r.sub.status === 'trialing' ? r.sub.trial_ends_at : r.sub.current_period_end;
        const lapsed = !subscriptionIsActive(r.sub) && r.sub.status !== 'pending_payment';
        return `<tr>
          <td><strong>${saasEsc(r.company.name)}</strong><div style="font-size:11px; color:var(--border);">Joined ${saasDate(r.company.created_at)}</div></td>
          <td>${saasEsc(r.sub.owner_name || '')}<div style="font-size:12px; color:var(--border);">${saasEsc(r.sub.owner_email || r.company.contact_email || '')}</div></td>
          <td>${r.plan ? saasEsc(r.plan.name) : '—'}${r.sub.amount ? `<div style="font-size:11px; color:var(--border);">${rands(r.sub.amount)}/${r.sub.billing_cycle === 'annual' ? 'yr' : 'mo'}</div>` : ''}</td>
          <td>${statusPill(r.sub.status)}${lapsed ? '<div style="font-size:11px; color:#B23B2E;">expired</div>' : ''}</td>
          <td style="white-space:nowrap;">${r.sub.status === 'comped' ? '—' : saasDate(until)}</td>
          <td style="text-align:right;">${r.rfqsThisMonth}${r.plan && r.plan.max_rfqs_per_month && r.sub.status !== 'comped' ? ` / ${r.plan.max_rfqs_per_month}` : ''}</td>
          <td>${canEdit ? `<button type="button" class="btn secondary" style="padding:6px 12px;" onclick="openManageSubscription('${r.company.id}')">Manage</button>` : ''}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
}

function toDateInput(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}

function openManageSubscription(companyId) {
  const row = SAAS.superRows.find(r => r.company.id === companyId);
  if (!row) return;
  let modal = document.getElementById('manage-sub-modal');
  if (!modal) {
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div id="manage-sub-modal" class="modal" style="display:none;"><div class="modal-content" style="max-width:520px;">
      <div class="modal-head"><h3 id="manage-sub-title">Manage subscription</h3><button class="drawer-close" onclick="closeModal('manage-sub-modal')">✕</button></div>
      <div class="modal-body" id="manage-sub-body"></div></div></div>`;
    document.body.appendChild(wrap.firstElementChild);
    modal = document.getElementById('manage-sub-modal');
  }
  const s = row.sub;
  document.getElementById('manage-sub-title').textContent = row.company.name;
  document.getElementById('manage-sub-body').innerHTML = `
    <input type="hidden" id="ms-company" value="${companyId}">
    <div style="display:flex; flex-direction:column; gap:12px;">
      <div><label style="font-weight:bold;">Status</label>
        <select id="ms-status" style="width:100%;">${Object.entries(SUB_STATUS).map(([k, v]) => `<option value="${k}" ${s.status === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
        <p style="font-size:12px; color:var(--border); margin:4px 0 0 0;"><strong>Complimentary</strong> = free, unlimited, no billing. <strong>Active</strong> needs a "Paid up until" date (use this for EFT payers).</p></div>
      <div><label style="font-weight:bold;">Plan</label>
        <select id="ms-plan" style="width:100%;"><option value="">—</option>${(SAAS.allPlans || []).map(p => `<option value="${p.id}" ${s.plan_id === p.id ? 'selected' : ''}>${saasEsc(p.name)}${p.is_active ? '' : ' (hidden)'}</option>`).join('')}</select></div>
      <div class="form-grid-2">
        <div><label style="font-weight:bold;">Trial ends</label><input type="date" id="ms-trial" value="${toDateInput(s.trial_ends_at)}" style="width:100%;"></div>
        <div><label style="font-weight:bold;">Paid up until</label><input type="date" id="ms-period" value="${toDateInput(s.current_period_end)}" style="width:100%;"></div>
      </div>
      <div><label style="font-weight:bold;">Internal notes</label><textarea id="ms-notes" style="width:100%; min-height:60px;">${saasEsc(s.notes || '')}</textarea></div>
      ${s.payfast_token ? `<p style="font-size:12px; color:var(--border); margin:0;">PayFast subscription on file${s.cancel_at_period_end ? ' (cancelled)' : ''}. Changing the status here does <strong>not</strong> stop PayFast billing. Use the button below for that.</p>` : ''}
      <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end;">
        ${s.payfast_token && !s.cancel_at_period_end ? `<button type="button" class="btn secondary" onclick="adminCancelPayfast('${companyId}')">Stop PayFast billing</button>` : ''}
        <button type="button" class="btn gold" onclick="saveManageSubscription()">Save</button>
      </div>
    </div>`;
  openModal('manage-sub-modal');
}

async function saveManageSubscription() {
  const companyId = document.getElementById('ms-company').value;
  const endOfDay = (v) => (v ? new Date(v + 'T23:59:59+02:00').toISOString() : null);
  const update = {
    status: document.getElementById('ms-status').value,
    plan_id: document.getElementById('ms-plan').value || null,
    trial_ends_at: endOfDay(document.getElementById('ms-trial').value),
    current_period_end: endOfDay(document.getElementById('ms-period').value),
    notes: document.getElementById('ms-notes').value.trim() || null,
    updated_at: new Date().toISOString(),
  };
  if (update.status === 'active' && !update.current_period_end) { showToast('Set a "Paid up until" date for an active subscription', 'error'); return; }
  if (update.status === 'trialing' && !update.trial_ends_at) { showToast('Set a "Trial ends" date for a trial', 'error'); return; }
  try {
    const { error } = await client.from('company_subscriptions').update(update).eq('company_id', companyId);
    if (error) throw error;
    closeModal('manage-sub-modal');
    showToast('✅ Subscription updated', 'success');
    loadSuperSubscriptions();
  } catch (err) {
    showToast('❌ ' + err.message, 'error');
  }
}

async function adminCancelPayfast(companyId) {
  if (!confirm('Stop PayFast billing for this company? Their access continues until their paid-up date.')) return;
  try {
    await callEdgeFunction('billing', { action: 'cancel', companyId });
    closeModal('manage-sub-modal');
    showToast('✅ PayFast billing stopped', 'success');
    loadSuperSubscriptions();
  } catch (err) {
    showToast('❌ ' + err.message, 'error');
  }
}

function renderSuperPlans() {
  const el = document.getElementById('super-plans-list');
  if (!el) return;
  const canEdit = typeof canEditSection === 'function' ? canEditSection('billing') : true;
  const dis = canEdit ? '' : 'disabled';
  const plans = SAAS.allPlans || [];
  el.innerHTML = plans.map(p => `
    <div class="plan-editor" data-plan="${p.id}">
      <div class="plan-editor-grid">
        <div><label>Name</label><input type="text" class="pe-name" value="${saasEsc(p.name)}" ${dis}></div>
        <div><label>Tagline</label><input type="text" class="pe-tagline" value="${saasEsc(p.tagline || '')}" ${dis}></div>
        <div><label>Price / month (R)</label><input type="number" min="0" step="1" class="pe-monthly" value="${p.price_monthly ?? ''}" ${dis}></div>
        <div><label>Price / year (R, blank = none)</label><input type="number" min="0" step="1" class="pe-annual" value="${p.price_annual ?? ''}" ${dis}></div>
        <div><label>RFQs per month (blank = unlimited)</label><input type="number" min="1" class="pe-rfqs" value="${p.max_rfqs_per_month ?? ''}" ${dis}></div>
        <div><label>Team logins (blank = unlimited)</label><input type="number" min="1" class="pe-team" value="${p.max_team_members ?? ''}" ${dis}></div>
        <div><label>Display order</label><input type="number" class="pe-sort" value="${p.sort_order ?? 0}" ${dis}></div>
        <div style="display:flex; gap:16px; align-items:flex-end;">
          <label style="display:flex; gap:6px; align-items:center; font-weight:normal;"><input type="checkbox" class="pe-active" ${p.is_active ? 'checked' : ''} ${dis}> Visible</label>
          <label style="display:flex; gap:6px; align-items:center; font-weight:normal;"><input type="checkbox" class="pe-featured" ${p.is_featured ? 'checked' : ''} ${dis}> "Most popular"</label>
        </div>
      </div>
      <label>Features (one per line)</label>
      <textarea class="pe-features" ${dis}>${saasEsc((Array.isArray(p.features) ? p.features : []).join('\n'))}</textarea>
      ${canEdit ? `<div style="text-align:right; margin-top:8px;"><button type="button" class="btn gold" style="padding:8px 18px;" onclick="savePlan('${p.id}')">Save ${saasEsc(p.name)}</button></div>` : ''}
    </div>`).join('') + (canEdit ? `
    <div style="display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap; margin-top:10px;">
      <div><label style="font-weight:bold;">New plan ID</label><input type="text" id="new-plan-id" placeholder="e.g. enterprise" style="padding:8px;"></div>
      <button type="button" class="btn secondary" onclick="addPlan()">+ Add plan</button>
    </div>` : '');
}

async function savePlan(id) {
  const box = document.querySelector(`.plan-editor[data-plan="${id}"]`);
  const num = (sel) => { const v = box.querySelector(sel).value.trim(); return v === '' ? null : Number(v); };
  const update = {
    name: box.querySelector('.pe-name').value.trim(),
    tagline: box.querySelector('.pe-tagline').value.trim() || null,
    price_monthly: num('.pe-monthly') ?? 0,
    price_annual: num('.pe-annual'),
    max_rfqs_per_month: num('.pe-rfqs'),
    max_team_members: num('.pe-team'),
    sort_order: num('.pe-sort') ?? 0,
    is_active: box.querySelector('.pe-active').checked,
    is_featured: box.querySelector('.pe-featured').checked,
    features: box.querySelector('.pe-features').value.split('\n').map(s => s.trim()).filter(Boolean),
    updated_at: new Date().toISOString(),
  };
  if (!update.name) { showToast('Plan name is required', 'error'); return; }
  if (update.is_active && update.price_monthly < 5) { showToast('A visible plan needs a monthly price of at least R5 (PayFast minimum)', 'error'); return; }
  try {
    const { error } = await client.from('subscription_plans').update(update).eq('id', id);
    if (error) throw error;
    SAAS.plansLoaded = false;
    showToast(`✅ ${update.name} saved`, 'success');
    loadSuperSubscriptions();
  } catch (err) {
    showToast('❌ ' + err.message, 'error');
  }
}

async function addPlan() {
  const id = (document.getElementById('new-plan-id').value || '').trim().toLowerCase();
  if (!/^[a-z0-9-]{2,30}$/.test(id)) { showToast('Plan ID: 2–30 lowercase letters, numbers or dashes', 'error'); return; }
  try {
    const { error } = await client.from('subscription_plans').insert([{ id, name: id.charAt(0).toUpperCase() + id.slice(1), price_monthly: 0, is_active: false, sort_order: 99 }]);
    if (error) throw error;
    showToast('✅ Plan added (hidden until you set a price and tick Visible)', 'success');
    loadSuperSubscriptions();
  } catch (err) {
    showToast('❌ ' + err.message, 'error');
  }
}

async function loadItnLog() {
  const el = document.getElementById('super-itn-log');
  if (!el) return;
  try {
    const { data, error } = await client.from('payfast_itn_log').select('*').order('received_at', { ascending: false }).limit(50);
    if (error) throw error;
    const companyName = (id) => (SAAS.superRows.find(r => r.company.id === id) || {}).company?.name || id || '—';
    el.innerHTML = (data && data.length) ? `<div style="overflow-x:auto;"><table class="saas-table">
      <thead><tr><th>Received</th><th>Company</th><th>Status</th><th style="text-align:right;">Amount</th><th>Result</th></tr></thead>
      <tbody>${data.map(l => `<tr>
        <td style="white-space:nowrap;">${new Date(l.received_at).toLocaleString('en-ZA')}</td>
        <td>${saasEsc(companyName(l.payload?.custom_str1))}</td>
        <td>${saasEsc(l.payload?.payment_status || '')}</td>
        <td style="text-align:right;">${l.payload?.amount_gross ? rands(l.payload.amount_gross) : ''}</td>
        <td style="color:${l.valid ? '#2E6B4F' : '#B23B2E'};">${l.valid ? '✓' : '✗'} ${saasEsc(l.reason || '')}</td></tr>`).join('')}</tbody></table></div>`
      : '<p style="color:var(--border);">No PayFast notifications received yet.</p>';
  } catch (err) {
    el.innerHTML = `<p style="color:#B23B2E;">${saasEsc(err.message)}</p>`;
  }
}

// ── Friendly handling of the database's publish gate ─────────

function showSubscriptionGateModal(message) {
  let modal = document.getElementById('sub-gate-modal');
  if (!modal) {
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div id="sub-gate-modal" class="modal" style="display:none;"><div class="modal-content" style="max-width:480px;">
      <div class="modal-head"><h3>Subscription needed to publish</h3><button class="drawer-close" onclick="closeModal('sub-gate-modal')">✕</button></div>
      <div class="modal-body"><p id="sub-gate-msg" style="line-height:1.6;"></p>
      <div style="display:flex; gap:10px; justify-content:flex-end;"><button type="button" class="btn secondary" onclick="closeModal('sub-gate-modal')">Close</button>
      <button type="button" class="btn gold" onclick="closeModal('sub-gate-modal'); openSubscriptionTab();">Go to Subscription</button></div></div></div></div>`;
    document.body.appendChild(wrap.firstElementChild);
  }
  document.getElementById('sub-gate-msg').textContent = message;
  openModal('sub-gate-modal');
}

// ── Hooks into app.js ────────────────────────────────────────

(function installSaasHooks() {
  const _showToast = showToast;
  showToast = function (message, type) {
    const m = String(message || '');
    const match = m.match(/(SUBSCRIPTION_INACTIVE|PLAN_LIMIT):\s*(.*)$/s);
    if (match) {
      showSubscriptionGateModal(match[2]);
      return;
    }
    return _showToast(message, type);
  };

  const _showLandingView = showLandingView;
  showLandingView = function () {
    const r = _showLandingView.apply(this, arguments);
    renderPricing();
    return r;
  };

  const _showAdminView = showAdminView;
  showAdminView = function () {
    const r = _showAdminView.apply(this, arguments);
    const tab = document.getElementById('subscription-tab');
    if (tab) tab.style.display = 'none';
    loadMySubscription().then(renderSubscriptionBanner);
    return r;
  };

  const _switchAdminTab = switchAdminTab;
  switchAdminTab = function (tabName, button) {
    const r = _switchAdminTab.apply(this, arguments);
    if (tabName === 'subscription') renderSubscriptionTab();
    return r;
  };

  const _switchSuperAdminTab = switchSuperAdminTab;
  switchSuperAdminTab = function (tabName, button) {
    const r = _switchSuperAdminTab.apply(this, arguments);
    if (tabName === 'super-subscriptions') loadSuperSubscriptions();
    return r;
  };

  // Returning from PayFast (?billing=success|cancelled)
  window.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const billing = params.get('billing');
    if (!billing) return;
    params.delete('billing');
    const qs = params.toString();
    history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
    setTimeout(() => {
      if (billing === 'success') {
        showToast('Thanks! PayFast is confirming your payment…', 'info');
        waitForActivation();
      } else if (billing === 'cancelled') {
        showToast('Payment was cancelled. Nothing was charged.', 'info');
      }
    }, 1500);
  });
})();
