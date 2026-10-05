// RFQ Hub - Multi-company Application Logic

// ============================================================
// INSTANCE CONFIG — the only values to change for this deployment.
// (The anon/publishable key is safe in the browser; RLS protects the data.)
// ============================================================
const SUPABASE_URL = 'https://rszmmtqsxszchywpydrz.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJzem1tdHFzeHN6Y2h5d3B5ZHJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEwMDIxNzMsImV4cCI6MjEwNjU3ODE3M30.Jyg7AhSS7NhPt0xTQnuFOrJZ8e4LH2n1KvJHrOlp40o';
// Must match the SITE_URL secret used by the Edge Functions EXACTLY (including
// the trailing slash) and be allow-listed in Supabase Auth → URL Configuration.
const SITE_URL = 'https://ihubsa.github.io/RFQhub/';
const SUPPORT_EMAIL = 'enquiries@ihub-sa.co.za';

let client = null;
let currentUser = null;
let currentCompany = null;
let isSuperAdmin = false;
let isAdminManager = false; // can this super admin invite/remove other super admins? (see super_admins.can_manage_admins)
let currentAdminPermissions = {}; // this super admin's per-section {view,edit} grants (see super_admins.permissions) — ignored entirely for the admin-manager, who always has full access
const ADMIN_PERMISSION_SECTIONS = ['invite_company', 'platform_branding', 'companies', 'applicants', 'billing'];
let currentMemberRole = null; // this user's own company_members.role ('owner'/'staff') — the owner always has full access to every Review Submissions stage regardless of currentMemberPermissions
let currentMemberPermissions = null; // this user's own company_members.permissions — null means full access to every stage (the default, until the owner explicitly restricts them); see company_members.permissions
// The 6 statuses a submission can be in, in the same order the status dropdown shows them.
const SUBMISSION_STAGES = [
  { key: 'submitted', label: 'Submitted' },
  { key: 'under_review', label: 'Under Review' },
  { key: 'info_requested', label: 'Request More Information' },
  { key: 'response_received', label: 'Response Received' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' }
];
let teamMembersById = {}; // populated by loadTeamMembers so the Permissions modal can look up a member's current role/permissions by id
let currentRFQId = null;
let currentRFQData = null; // full RFQ row for the RFQ currently loaded in the contractor form, so submitContractorForm can read required_documents (name/mandatory/requires_expiry) without a second fetch
let currentRFQCompanyName = null; // company name for the current RFQ, used in confirmation emails
let isSubmittingRFQ = false;
let platformSettings = { logo_url: null };
window.lastInvitations = [];
let pendingAskQuestionRfqId = null; // which RFQ the open "Ask a Question" modal is for
let pendingAnswerQuestionId = null; // which rfq_questions row the open "Reply" modal is answering
let pendingExpandSearchRfqId = null; // which RFQ the open "Expand Supplier Search" modal is for
let rfqQuestionsById = {}; // populated by loadRFQConsole so the answer modal can look up question text without embedding free-form text in onclick attributes
let currentAuthType = null; // 'invite' or 'recovery' when landing from an invite/reset-password link — lets showSetPasswordView() tailor its copy (same form/flow handles both)
let passwordResetEmail = null; // email address a forgot-password code was just sent to, kept so the code-entry step can call verifyOtp() without asking again
let currentDraftId = null; // id of the RFQ currently loaded into the Create RFQ form, if any — set when "Continue Editing"/"Edit" is clicked or right after the first Save Draft, so subsequent Save Draft/Publish calls UPDATE that row instead of inserting a new one
let currentEditingIsDraft = true; // only meaningful when currentDraftId is set — true while editing a not-yet-published draft (Save Draft is safe), false while editing an already-created RFQ via editRFQ() (Save Draft is hidden, since it would wrongly flip a live/closed RFQ's is_draft back to true)
let currentEditingIsReleased = false; // only meaningful when currentDraftId is set and currentEditingIsDraft is false — true when editRFQ() loaded a row that's already been released, in which case the "🚀 Publish RFQ" button is hidden (nothing left to publish) and only Save Changes shows

// Privacy popup tracking for supplier registration and RFQ application
let registrationPrivacyAccepted = false;
let applicationPrivacyAccepted = false;
let pendingGateRfqIdAfterPrivacy = null; // stores the RFQ ID to apply to after privacy acceptance

// Supplier password reset tracking
let supplierPasswordResetEmail = null; // email address for supplier password reset flow

const DEFAULT_HERO_SUBTITLE = "Open requests for quotation. Apply directly online — you'll get a reference number and a confirmation the moment your application is received.";

// ===== INITIALIZATION =====
async function initApp() {
  console.log('Initializing RFQ Hub...');

  // Capture the URL's search params and auth hash FIRST, before any
  // await below. Supabase's own client processes and clears the
  // #access_token=...&type=invite hash asynchronously as soon as the
  // client is created — if we read it after an await, it's often already
  // gone by the time we check it, which silently skips the "set your
  // password" screen for invite/recovery links.
  const params = new URLSearchParams(window.location.search);
  const rfqToken = params.get('rfq');
  const openRfqId = params.get('open');
  const infoToken = params.get('info');
  const prefsToken = params.get('prefs');
  const wantsAdmin = params.has('admin');
  const hashParams = getUrlHashParams();
  const authType = hashParams.get('type'); // 'invite' or 'recovery' when landing from an invite/reset link
  // Supabase's admin.inviteUserByEmail (invite-member/invite-super-admin)
  // is NOT one of the flows that support PKCE — per Supabase's own docs,
  // only Magic Link, OAuth, Sign Up, and Password Recovery do. An invite
  // link therefore always comes back as the classic implicit-flow
  // #access_token=...&refresh_token=...&type=invite hash, never a PKCE
  // ?code=. With this client configured flowType:'pkce' (added for the
  // recovery-link email-scanner problem below), relying on supabase-js's
  // automatic detectSessionInUrl to also pick up that hash turned out to
  // be unreliable in practice — confirmed via Supabase auth logs showing
  // the server minting a valid implicit-flow session on /verify, but the
  // client never following up with a session-backed request afterward
  // (an invited team member's "Accept invitation" link was landing on
  // the public Open Opportunities page instead of the set-password
  // screen). Reading the tokens straight out of the hash ourselves and
  // handing them to setSession() below doesn't depend on that automatic
  // detection working, so it fixes invite links without touching the
  // (working) recovery-link path.
  const hashAccessToken = hashParams.get('access_token');
  const hashRefreshToken = hashParams.get('refresh_token');
  // A scanner or a stale/already-used link lands here with #error=...
  // instead of tokens (this is the exact "email security scanner
  // pre-fetches and burns the one-time link" failure mode already traced
  // to angelsinc.co.za's Microsoft 365 Safe Links for recovery links —
  // invite links were never actually protected against it, since invite
  // doesn't support the PKCE fix that protects recovery). Previously this
  // fell straight through to the public landing page with no explanation;
  // surfacing it means whoever's testing/using an invite link finds out
  // why it didn't work instead of just landing somewhere unexpected.
  const hashError = hashParams.get('error_description') || hashParams.get('error');
  currentAuthType = authType;

  // Wire up static form/UI listeners before touching the Supabase client —
  // this work has no network dependency, so the page stays interactive
  // (login form, settings sliders, etc.) even if the Supabase SDK is slow
  // to load from its CDN, and it means a client-creation failure below
  // can't silently skip wiring the rest of the page.
  setupStaticForms();
  setupWhatsappFabSync();

  // PKCE flow: SELF-INITIATED recovery links (resetPasswordForEmail, used
  // by the "Forgot your password?" flow) require both the emailed link
  // AND a secret held only by the browser that originally requested it,
  // so an email security scanner pre-fetching the link (which is what was
  // silently burning those links before a real person ever clicked them —
  // confirmed via Supabase logs, and traced to angelsinc.co.za running
  // Microsoft 365, whose Safe Links feature does exactly this) can no
  // longer consume the one-time login on its own. supabase-js handles the
  // code exchange automatically (via detectSessionInUrl) for THIS flow.
  // Invite links are a different story — see the comment above authType.
  client = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { flowType: 'pkce' } });
  console.log('✅ Supabase connected');

  // Belt-and-suspenders alongside the hash-based authType check above:
  // supabase-js fires a dedicated PASSWORD_RECOVERY auth event once it
  // finishes processing a recovery link, independent of our own hash
  // parsing. This is the library's own recommended way to detect a
  // recovery flow, and it's the authoritative signal — if it fires, force
  // the set-password screen even if something upstream already routed
  // elsewhere (e.g. into the dashboard) based on the hash check alone.
  client.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      console.log('PASSWORD_RECOVERY event received');
      currentAuthType = 'recovery';
      if (session && session.user) currentUser = session.user;
      applyDefaultBranding();
      showSetPasswordView();
    }
  });

  if (hashAccessToken && hashRefreshToken) {
    // See the big comment above authType: this is what actually makes an
    // invite link's implicit-flow hash result in a logged-in session —
    // don't rely on detectSessionInUrl alone to have picked it up already.
    try {
      const { error: setSessionError } = await client.auth.setSession({
        access_token: hashAccessToken,
        refresh_token: hashRefreshToken,
      });
      if (setSessionError) console.error('setSession from hash tokens failed:', setSessionError.message);
    } catch (err) {
      console.error('setSession from hash tokens threw:', err);
    }
    // The tokens have done their job — drop them from the address bar so
    // they're not left sitting there (visible in browser history, and
    // liable to cause a stale re-processing attempt on a manual refresh).
    history.replaceState(null, '', window.location.pathname + window.location.search);
  } else if (hashError) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
    applyDefaultBranding();
    showLoginForm();
    showToast('❌ This invite/reset link has already been used or has expired. Ask whoever sent it to send a new one.', 'error');
    return;
  }

  await loadPlatformSettings();

  if (rfqToken) {
    console.log('Loading RFQ with token:', rfqToken);
    applyDefaultBranding();
    setHeaderActions('contractor');
    await loadContractorView(rfqToken);
    return;
  }

  if (infoToken) {
    console.log('Loading information request with token:', infoToken);
    applyDefaultBranding();
    setHeaderActions('contractor');
    await loadInfoRequestView(infoToken);
    return;
  }

  if (prefsToken) {
    console.log('Loading supplier notification preferences with token:', prefsToken);
    applyDefaultBranding();
    setHeaderActions('contractor');
    await loadSupplierPreferencesView(prefsToken);
    return;
  }

  if (openRfqId) {
    // Direct links (e.g. bookmarked/shared) must go through the same
    // registration gate as clicking "View & Apply" — show the normal
    // landing page underneath and open the gate on top of it.
    console.log('Loading public RFQ (gated):', openRfqId);
    applyDefaultBranding();
    showLandingView();
    openApplicantGateOrRedirect(openRfqId);
    return;
  }

  try {
    const { data: { session } } = await client.auth.getSession();
    if (session && session.user) {
      currentUser = session.user;

      // A PKCE-flow recovery link redirects back with a ?code= query
      // param rather than a hash, so authType (read from the hash, above)
      // is null in that case — the PASSWORD_RECOVERY listener above is
      // what catches those instead. authType IS reliably set for an
      // invite link, which always comes back as a hash (see the big
      // comment above authType near the top of this function).
      // needs_password_setup in the user's own metadata is a second,
      // independent signal — set ourselves when the invite was sent (see
      // invite-super-admin/invite-member) and cleared once they've set a
      // password (see handleSetPasswordSubmit) — kept as a belt-and-
      // suspenders check that doesn't depend on any particular redirect
      // shape at all.
      const stillNeedsPasswordSetup = !!(session.user.user_metadata && session.user.user_metadata.needs_password_setup);

      if (authType === 'invite' || authType === 'recovery' || stillNeedsPasswordSetup) {
        // They have a valid session from the invite link but haven't set a
        // password yet — make them do that before routing into the dashboard.
        applyDefaultBranding();
        showSetPasswordView();
        return;
      }

      await loadCurrentCompanyAndRoute(wantsAdmin);
      return;
    }
  } catch (err) {
    console.error('Error checking session:', err);
  }

  applyDefaultBranding();
  if (wantsAdmin) {
    showLoginForm();
  } else {
    showLandingView();
  }
}

function setupStaticForms() {
  const loginForm = document.getElementById('login-form');
  if (loginForm && !loginForm.dataset.wired) {
    loginForm.addEventListener('submit', handleLoginSubmit);
    loginForm.dataset.wired = 'true';
  }

  const setPasswordForm = document.getElementById('set-password-form');
  if (setPasswordForm && !setPasswordForm.dataset.wired) {
    setPasswordForm.addEventListener('submit', handleSetPasswordSubmit);
    setPasswordForm.dataset.wired = 'true';
  }

  const forgotPasswordForm = document.getElementById('forgot-password-form');
  if (forgotPasswordForm && !forgotPasswordForm.dataset.wired) {
    forgotPasswordForm.addEventListener('submit', handleForgotPasswordSubmit);
    forgotPasswordForm.dataset.wired = 'true';
  }

  const resetCodeForm = document.getElementById('reset-code-form');
  if (resetCodeForm && !resetCodeForm.dataset.wired) {
    resetCodeForm.addEventListener('submit', handleResetCodeSubmit);
    resetCodeForm.dataset.wired = 'true';
  }

  const supplierForgotPasswordForm = document.getElementById('supplier-forgot-password-form');
  if (supplierForgotPasswordForm && !supplierForgotPasswordForm.dataset.wired) {
    supplierForgotPasswordForm.addEventListener('submit', handleSupplierForgotPasswordSubmit);
    supplierForgotPasswordForm.dataset.wired = 'true';
  }

  const supplierResetCodeForm = document.getElementById('supplier-reset-code-form');
  if (supplierResetCodeForm && !supplierResetCodeForm.dataset.wired) {
    supplierResetCodeForm.addEventListener('submit', handleSupplierResetCodeSubmit);
    supplierResetCodeForm.dataset.wired = 'true';
  }

  const settingsForm = document.getElementById('settings-form');
  if (settingsForm && !settingsForm.dataset.wired) {
    settingsForm.addEventListener('submit', handleSettingsSubmit);
    settingsForm.dataset.wired = 'true';
  }

  const logoFile = document.getElementById('settings-logo-file');
  if (logoFile && !logoFile.dataset.wired) {
    logoFile.addEventListener('change', handleLogoFileChange);
    logoFile.dataset.wired = 'true';
  }

  const logoScale = document.getElementById('settings-logo-scale');
  if (logoScale && !logoScale.dataset.wired) {
    logoScale.addEventListener('input', handleSettingsLogoScaleInput);
    logoScale.addEventListener('change', handleSettingsLogoScaleChange);
    logoScale.dataset.wired = 'true';
  }

  const changePasswordForm = document.getElementById('change-password-form');
  if (changePasswordForm && !changePasswordForm.dataset.wired) {
    changePasswordForm.addEventListener('submit', handleChangePasswordSubmit);
    changePasswordForm.dataset.wired = 'true';
  }

  const superChangePasswordForm = document.getElementById('super-change-password-form');
  if (superChangePasswordForm && !superChangePasswordForm.dataset.wired) {
    superChangePasswordForm.addEventListener('submit', handleSuperChangePasswordSubmit);
    superChangePasswordForm.dataset.wired = 'true';
  }

  const inviteTeammateForm = document.getElementById('invite-teammate-form');
  if (inviteTeammateForm && !inviteTeammateForm.dataset.wired) {
    inviteTeammateForm.addEventListener('submit', handleInviteTeammateSubmit);
    inviteTeammateForm.dataset.wired = 'true';
  }

  const inviteCompanyForm = document.getElementById('invite-company-form');
  if (inviteCompanyForm && !inviteCompanyForm.dataset.wired) {
    inviteCompanyForm.addEventListener('submit', handleInviteCompanySubmit);
    inviteCompanyForm.dataset.wired = 'true';
  }

  const inviteSuperAdminForm = document.getElementById('invite-super-admin-form');
  if (inviteSuperAdminForm && !inviteSuperAdminForm.dataset.wired) {
    inviteSuperAdminForm.addEventListener('submit', handleInviteSuperAdminSubmit);
    inviteSuperAdminForm.dataset.wired = 'true';
  }
  wirePermissionCheckboxes('invite-perm');
  wirePermissionCheckboxes('edit-perm');

  const platformLogoFile = document.getElementById('platform-logo-file');
  if (platformLogoFile && !platformLogoFile.dataset.wired) {
    platformLogoFile.addEventListener('change', handlePlatformLogoFileChange);
    platformLogoFile.dataset.wired = 'true';
  }

  const platformLogoScale = document.getElementById('platform-logo-scale');
  if (platformLogoScale && !platformLogoScale.dataset.wired) {
    platformLogoScale.addEventListener('input', handlePlatformLogoScaleInput);
    platformLogoScale.addEventListener('change', handlePlatformLogoScaleChange);
    platformLogoScale.dataset.wired = 'true';
  }

  const gateEmailForm = document.getElementById('gate-email-form');
  if (gateEmailForm && !gateEmailForm.dataset.wired) {
    gateEmailForm.addEventListener('submit', handleGateEmailSubmit);
    gateEmailForm.dataset.wired = 'true';
  }

  const gateRegisterForm = document.getElementById('gate-register-form');
  if (gateRegisterForm && !gateRegisterForm.dataset.wired) {
    gateRegisterForm.addEventListener('submit', handleGateRegisterSubmit);
    gateRegisterForm.dataset.wired = 'true';
  }

  const askQuestionForm = document.getElementById('ask-question-form');
  if (askQuestionForm && !askQuestionForm.dataset.wired) {
    askQuestionForm.addEventListener('submit', handleAskQuestionSubmit);
    askQuestionForm.dataset.wired = 'true';
  }

  const answerQuestionForm = document.getElementById('answer-question-form');
  if (answerQuestionForm && !answerQuestionForm.dataset.wired) {
    answerQuestionForm.addEventListener('submit', handleAnswerQuestionSubmit);
    answerQuestionForm.dataset.wired = 'true';
  }

  const expandSearchForm = document.getElementById('expand-search-form');
  if (expandSearchForm && !expandSearchForm.dataset.wired) {
    expandSearchForm.addEventListener('submit', handleExpandSearchSubmit);
    expandSearchForm.dataset.wired = 'true';
  }

  const editSupplierForm = document.getElementById('edit-supplier-form');
  if (editSupplierForm && !editSupplierForm.dataset.wired) {
    editSupplierForm.addEventListener('submit', handleEditSupplierSubmit);
    editSupplierForm.dataset.wired = 'true';
  }

  const rfqAttachmentsInput = document.getElementById('rfq-attachments-input');
  if (rfqAttachmentsInput && !rfqAttachmentsInput.dataset.wired) {
    rfqAttachmentsInput.addEventListener('change', handleRFQFileInputChange);
    rfqAttachmentsInput.dataset.wired = 'true';
  }

  renderRFQProvinceCheckboxes();
  setupLocalPreferenceToggle();
}

// Populates the "Province(s)" checkbox group on the Create RFQ form from
// PROVINCE_OPTIONS (single source of truth, shared with the Expand Search
// modal and the supplier preferences page) and wires the "Select All"
// convenience toggle. Guarded by dataset.populated so it only runs once,
// same pattern used for the Supplier Database province filter select.
function renderRFQProvinceCheckboxes() {
  const container = document.getElementById('rfq-province-checkboxes');
  if (!container || container.dataset.populated) return;

  container.innerHTML = PROVINCE_OPTIONS.map(p => `
    <label style="display:flex; align-items:center; gap:6px; font-weight:normal; cursor:pointer;">
      <input type="checkbox" class="rfq-province-checkbox" value="${p}"> ${p}
    </label>
  `).join('');
  container.dataset.populated = 'true';

  const selectAll = document.getElementById('rfq-province-select-all');
  if (selectAll) {
    selectAll.addEventListener('change', () => {
      container.querySelectorAll('.rfq-province-checkbox').forEach(cb => { cb.checked = selectAll.checked; });
    });
  }
  container.addEventListener('change', (e) => {
    if (!e.target.classList.contains('rfq-province-checkbox')) return;
    const all = container.querySelectorAll('.rfq-province-checkbox');
    const checkedCount = container.querySelectorAll('.rfq-province-checkbox:checked').length;
    if (selectAll) selectAll.checked = checkedCount === all.length;
  });
}

// Setup event listener for Local/Non-Local preference radio buttons to show/hide the reason field
function setupLocalPreferenceToggle() {
  const radios = document.querySelectorAll('input[name="rfq_local_preference"]');
  const reasonContainer = document.getElementById('non-local-reason-container');
  if (!radios.length || !reasonContainer) return;

  const updateVisibility = () => {
    const selected = document.querySelector('input[name="rfq_local_preference"]:checked');
    if (selected && selected.value === 'non-local') {
      reasonContainer.style.display = 'block';
    } else {
      reasonContainer.style.display = 'none';
    }
  };

  radios.forEach(radio => {
    radio.addEventListener('change', updateVisibility);
  });

  // Initialize on page load
  updateVisibility();
}

function renderPlatformLogoPreview() {
  const preview = document.getElementById('platform-logo-preview');
  const placeholder = document.getElementById('platform-logo-placeholder');
  const scaleInput = document.getElementById('platform-logo-scale');
  const scaleLabel = document.getElementById('platform-logo-scale-label');
  if (!preview || !placeholder) return;

  const scale = (platformSettings && platformSettings.logo_scale) || 1;
  if (scaleInput) scaleInput.value = Math.round(scale * 100);
  if (scaleLabel) scaleLabel.textContent = `${Math.round(scale * 100)}%`;

  if (platformSettings && platformSettings.logo_url) {
    applyLogoScale(preview, scale);
    preview.src = platformSettings.logo_url;
    preview.style.display = 'block';
    placeholder.style.display = 'none';
  } else {
    preview.style.display = 'none';
    placeholder.style.display = 'flex';
  }
}

function handlePlatformLogoScaleInput(e) {
  const pct = Number(e.target.value);
  const label = document.getElementById('platform-logo-scale-label');
  if (label) label.textContent = `${pct}%`;
  const preview = document.getElementById('platform-logo-preview');
  if (preview && preview.style.display !== 'none') {
    applyLogoScale(preview, pct / 100);
  }
}

async function handlePlatformLogoScaleChange(e) {
  if (!isSuperAdmin) return;
  const pct = Number(e.target.value);
  const scale = Math.min(1.5, Math.max(0.5, pct / 100));
  try {
    const { error } = await client
      .from('platform_settings')
      .update({ logo_scale: scale, updated_at: new Date().toISOString() })
      .eq('id', 1);
    if (error) throw error;

    platformSettings = { ...platformSettings, logo_scale: scale };

    const brandImg = document.getElementById('brand-logo-img');
    if (brandImg && brandImg.style.display !== 'none') {
      applyLogoScale(brandImg, scale);
    }

    showToast('✅ Logo size saved', 'success');
  } catch (err) {
    console.error('Error saving logo size:', err);
    showToast('❌ Error saving logo size: ' + err.message, 'error');
  }
}

async function handlePlatformLogoFileChange(e) {
  const file = e.target.files[0];
  if (!file || !isSuperAdmin) return;

  try {
    showToast('Uploading logo...', 'info');
    const ext = (file.name.split('.').pop() || 'png').toLowerCase();
    const path = `platform/logo-${Date.now()}.${ext}`;

    const { error: uploadError } = await client.storage
      .from('company-logos')
      .upload(path, file, { upsert: true });
    if (uploadError) throw uploadError;

    const { data: urlData } = client.storage.from('company-logos').getPublicUrl(path);
    const logoUrl = urlData.publicUrl;

    const { error: updateError } = await client
      .from('platform_settings')
      .update({ logo_url: logoUrl, updated_at: new Date().toISOString() })
      .eq('id', 1);
    if (updateError) throw updateError;

    platformSettings = { ...platformSettings, logo_url: logoUrl };
    renderPlatformLogoPreview();
    showToast('✅ Platform logo updated', 'success');
  } catch (err) {
    console.error('Platform logo upload error:', err);
    showToast('❌ Error uploading logo: ' + err.message, 'error');
  }
}

function getUrlHashParams() {
  const hash = window.location.hash && window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : (window.location.hash || '');
  return new URLSearchParams(hash);
}

// ===== VIEW SWITCHING =====
function hideAllTopLevelViews() {
  document.getElementById('public-view').style.display = 'none';
  document.getElementById('admin-view').style.display = 'none';
  document.getElementById('super-admin-view').style.display = 'none';
  const heroExtras = document.getElementById('hero-marketplace-extras');
  if (heroExtras) heroExtras.style.display = 'none';
  closeMobileNav();
}

// Keeps the floating WhatsApp help button (a sibling of public-view/admin-view/
// super-admin-view — see index.html) in sync with whichever of those views is
// currently showing, without needing a "show the fab" call added to every one
// of the several functions that show public-view or admin-view. Shown for the
// public applicant-facing pages and the contractor company dashboard; hidden
// for the platform Super Admin view (and whenever nothing's shown yet, e.g.
// during initial load).
function setupWhatsappFabSync() {
  const fab = document.getElementById('whatsapp-help-btn');
  const publicView = document.getElementById('public-view');
  const adminView = document.getElementById('admin-view');
  if (!fab || !publicView || !adminView) return;

  const sync = () => {
    const visible = publicView.style.display !== 'none' || adminView.style.display !== 'none';
    fab.style.display = visible ? 'flex' : 'none';
  };

  new MutationObserver(sync).observe(publicView, { attributes: true, attributeFilter: ['style'] });
  new MutationObserver(sync).observe(adminView, { attributes: true, attributeFilter: ['style'] });
  sync();
}

function hideAllPublicSections() {
  ['rfq-portal', 'no-rfq-message', 'landing-section', 'login-section', 'forgot-password-section', 'set-password-section'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

// mode: 'loggedOut' (landing — full Sign In + Register Free), 'contractor'
// (viewing/applying to a specific RFQ — Sign In only, Register Free would
// be redundant mid-flow), 'form' (already on the login/set-password page —
// no action buttons needed). Admin/super-admin views never call this, so
// whatever the last mode was (always 'form', reached via login) persists,
// which correctly shows no public CTAs while logged in.
function setHeaderActions(mode) {
  const el = document.getElementById('header-actions');
  if (!el) return;
  if (mode === 'loggedOut') {
    el.innerHTML = `
      <button onclick="showLoginForm()" class="btn header-signin" type="button">Sign In</button>
      <button onclick="openApplicantGate(null)" class="btn header-register" type="button">Register Free</button>
    `;
  } else if (mode === 'contractor') {
    el.innerHTML = `
      <button onclick="showLoginForm()" class="btn header-signin" type="button">Sign In</button>
    `;
  } else {
    el.innerHTML = '';
  }
}

function toggleMobileNav() {
  const wrap = document.getElementById('site-nav-wrap');
  const toggle = document.getElementById('mobile-nav-toggle');
  if (!wrap) return;
  const isOpen = wrap.classList.toggle('open');
  if (toggle) toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
}

function closeMobileNav() {
  const wrap = document.getElementById('site-nav-wrap');
  const toggle = document.getElementById('mobile-nav-toggle');
  if (wrap) wrap.classList.remove('open');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
}

// ===== PUBLIC NAV LINKS =====
// "Opportunities" / "How It Works" always route back to the landing page
// first (they need to work from any public page — an RFQ detail page, the
// login form, etc.) then scroll to the relevant section once it's rendered.
function navGoOpportunities() {
  showLandingView();
  setTimeout(() => {
    const el = document.getElementById('public-rfq-list');
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  }, 50);
}

function navGoHowItWorks() {
  showLandingView();
  setTimeout(() => {
    const el = document.getElementById('how-it-works-section');
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  }, 50);
}

// About/Help/Terms don't have real content yet — a placeholder modal is
// shown rather than inventing company copy or legal text. Easy to swap for
// a real page later without touching any of the calling code.
function showInfoPlaceholder(title, body) {
  document.getElementById('info-page-modal-title').textContent = title;
  document.getElementById('info-page-modal-body').textContent = body;
  openModal('info-page-modal');
}

function navGoAbout() {
  closeMobileNav();
  showInfoPlaceholder('About', 'This page is coming soon. In the meantime, reach out using the Help link if you have questions about the platform.');
}

function navGoHelp() {
  closeMobileNav();
  showInfoPlaceholder('Need Help?', `If you run into any issues, or anything doesn't match what you're seeing on screen, email ${SUPPORT_EMAIL} and we'll help you sort it out.`);
}

function navGoTerms() {
  closeMobileNav();
  openModal('terms-modal');
}

function showLandingView() {
  hideAllTopLevelViews();
  document.getElementById('public-view').style.display = 'block';
  hideAllPublicSections();
  document.getElementById('landing-section').style.display = 'block';
  setHeaderActions('loggedOut');

  document.getElementById('hero-title').textContent = 'Looking for work? Let the RFQs find you.';
  document.getElementById('hero-subtitle').textContent = 'Contractors across South Africa publish their Requests for Quotation here. Register free as a supplier, choose your provinces, and get an email the moment a matching opportunity opens. Then quote online, in one place.';
  const heroExtras = document.getElementById('hero-marketplace-extras');
  if (heroExtras) heroExtras.style.display = 'block';

  loadPublicRFQList();
  loadPublicPortalStats();
}

// ===== PUBLIC RFQ PORTAL =====
const ICON_CALENDAR = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>';
const ICON_PIN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>';
const ICON_TAG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41L11 3.83A2 2 0 0 0 9.59 3.24L4 3v5.59a2 2 0 0 0 .59 1.41l9.58 9.58a2 2 0 0 0 2.83 0l3.59-3.59a2 2 0 0 0 0-2.83z"/><circle cx="8" cy="8" r="1.5"/></svg>';

// Computes {days, hrs, mins} remaining until an ISO deadline, clamped to
// zero once it has passed (the public list only ever fetches future
// deadlines, but a card can outlive its deadline while a visitor is
// still on the page).
function computeCountdownParts(deadlineIso) {
  const diffMs = new Date(deadlineIso).getTime() - Date.now();
  if (diffMs <= 0) return { days: 0, hrs: 0, mins: 0 };
  const totalMins = Math.floor(diffMs / 60000);
  return {
    days: Math.floor(totalMins / 1440),
    hrs: Math.floor((totalMins % 1440) / 60),
    mins: totalMins % 60
  };
}

// Buckets remaining time into an urgency status so cards can visually
// communicate how soon an RFQ closes, not just show raw numbers.
function computeUrgency(deadlineIso) {
  const diffMs = new Date(deadlineIso).getTime() - Date.now();
  const hrsRemaining = diffMs / 3600000;
  if (diffMs <= 0) return { status: 'closed', label: 'Closed', badgeClass: 'badge-closed' };
  if (hrsRemaining < 24) return { status: 'closing-today', label: 'Closing Today', badgeClass: 'badge-closing-today' };
  if (hrsRemaining < 48) return { status: 'closing-soon', label: 'Closing Soon', badgeClass: 'badge-closing-soon' };
  return { status: 'open', label: 'Open', badgeClass: 'badge-open' };
}

let countdownIntervalStarted = false;
function updateAllCountdowns() {
  document.querySelectorAll('.countdown-units[data-deadline]').forEach(el => {
    const parts = computeCountdownParts(el.dataset.deadline);
    const daysEl = el.querySelector('.cd-days');
    const hrsEl = el.querySelector('.cd-hrs');
    const minsEl = el.querySelector('.cd-mins');
    if (daysEl) daysEl.textContent = parts.days;
    if (hrsEl) hrsEl.textContent = parts.hrs;
    if (minsEl) minsEl.textContent = parts.mins;

    const urgency = computeUrgency(el.dataset.deadline);
    const box = el.closest('.countdown-box');
    if (box) {
      box.classList.remove('urgency-closing-soon', 'urgency-closing-today', 'urgency-closed');
      if (urgency.status !== 'open') box.classList.add(`urgency-${urgency.status}`);
      const labelEl = box.querySelector('.countdown-urgency-label');
      if (labelEl) {
        labelEl.textContent = urgency.status === 'closed' ? 'Closed' : (urgency.status === 'open' ? 'Closing In' : urgency.label);
        labelEl.className = `countdown-urgency-label ${urgency.status}`;
      }
    }

    // Keep the card's top status badge (and its colour-coded left border)
    // in sync too, in case a visitor lingers long enough for an RFQ to
    // cross an urgency threshold.
    const card = el.closest('.opportunity-card');
    if (card) {
      card.classList.remove('status-open', 'status-closing-soon', 'status-closing-today', 'status-closed');
      card.classList.add(`status-${urgency.status}`);
    }
    const badgeEl = card ? card.querySelector('.opportunity-status-badge') : null;
    if (badgeEl) {
      badgeEl.className = `opportunity-status-badge ${urgency.badgeClass}`;
      badgeEl.textContent = urgency.label;
    }
  });
}
function ensureCountdownTicking() {
  if (countdownIntervalStarted) return;
  countdownIntervalStarted = true;
  setInterval(updateAllCountdowns, 30000);
}

function clearOpportunityFilters() {
  const provinceEl = document.getElementById('public-rfq-province-filter');
  const searchEl = document.getElementById('hero-search-input');
  const sortEl = document.getElementById('public-rfq-sort');
  if (provinceEl) provinceEl.value = '';
  if (searchEl) searchEl.value = '';
  if (sortEl) sortEl.value = 'deadline_asc';
  loadPublicRFQList();
}

async function loadPublicRFQList() {
  const listEl = document.getElementById('public-rfq-list');
  if (!listEl) return;

  const provinceEl = document.getElementById('public-rfq-province-filter');
  const searchEl = document.getElementById('hero-search-input');
  const sortEl = document.getElementById('public-rfq-sort');
  const province = provinceEl ? provinceEl.value : '';
  const searchText = (searchEl ? searchEl.value : '').trim().toLowerCase();
  const sortMode = sortEl ? sortEl.value : 'deadline_asc';
  const hasActiveFilters = !!(province || searchText);

  listEl.innerHTML = '<p style="color:var(--border);">Loading...</p>';

  try {
    // Show RFQs that are either:
    // 1. Still open (deadline > now), OR
    // 2. Closed within the last 3 days (deadline <= now AND deadline > now - 3 days)
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

    let query = client
      .from('rfqs')
      .select('id, rfq_name, project_name, description, deadline, budget, company_id, provinces, location_area')
      .eq('is_public', true)
      .eq('is_withdrawn', false)
      .gte('deadline', threeDaysAgo.toISOString());

    if (province) {
      // rfqs.provinces is a jsonb array — .contains() maps to Postgres' @>
      // containment operator, so this matches any RFQ whose province list
      // includes the one the visitor picked, regardless of how many others
      // it also covers.
      query = query.contains('provinces', [province]);
    }

    const { data: fetchedRfqs, error } = await query;
    if (error) throw error;

    let rfqs = fetchedRfqs || [];

    // Fetch companies before filtering/rendering so search can match on
    // company name too, and so the "Organisations Using the Platform"
    // strip can be built from the same real, already-public data — no
    // separate query and nothing invented.
    const companyIds = [...new Set(rfqs.map(r => r.company_id).filter(Boolean))];
    let companiesById = {};
    if (companyIds.length > 0) {
      const { data: companies } = await client
        .from('companies')
        .select('id, name, logo_url, logo_scale')
        .in('id', companyIds);
      companiesById = Object.fromEntries((companies || []).map(c => [c.id, c]));
    }
    renderOrgLogos(companiesById);

    if (searchText) {
      rfqs = rfqs.filter(r => {
        const company = companiesById[r.company_id];
        return (r.rfq_name || '').toLowerCase().includes(searchText) ||
          (r.project_name || '').toLowerCase().includes(searchText) ||
          (r.description || '').toLowerCase().includes(searchText) ||
          (r.location_area || '').toLowerCase().includes(searchText) ||
          (r.provinces || []).some(p => p.toLowerCase().includes(searchText)) ||
          (company && company.name || '').toLowerCase().includes(searchText);
      });
    }

    if (sortMode === 'deadline_desc') {
      rfqs.sort((a, b) => new Date(b.deadline) - new Date(a.deadline));
    } else if (sortMode === 'budget_desc') {
      rfqs.sort((a, b) => (b.budget || 0) - (a.budget || 0));
    } else {
      rfqs.sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
    }

    if (rfqs.length === 0) {
      listEl.innerHTML = hasActiveFilters
        ? `<div class="opp-empty-state">
             <h4>No Open Opportunities</h4>
             <p>There are currently no open RFQs matching your search.</p>
             <button type="button" class="btn secondary" onclick="clearOpportunityFilters()">Clear Filters</button>
           </div>`
        : `<div class="opp-empty-state">
             <h4>No Open Opportunities</h4>
             <p>There are currently no open RFQs. Check back soon for new opportunities.</p>
           </div>`;
      return;
    }

    listEl.innerHTML = rfqs.map(rfq => {
      const company = companiesById[rfq.company_id];
      const deadlineDate = new Date(rfq.deadline);
      const locationParts = [rfq.location_area, ...(rfq.provinces || [])].filter(Boolean);
      const locationText = locationParts.join(', ');
      const cardLogoScale = Math.min(1.5, Math.max(0.5, (company && company.logo_scale) || 1));
      const cardLogoHeight = Math.round(40 * cardLogoScale);
      const cardLogoMaxWidth = Math.round(130 * cardLogoScale);
      const urgency = computeUrgency(rfq.deadline);
      const refCode = `RFQ-${rfq.id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
      const inGracePeriod = isInGracePeriod(rfq.deadline);
      const gracePeriodExpired = isGracePeriodExpired(rfq.deadline);

      return `
        <div class="opportunity-card status-${urgency.status}" onclick="openApplicantGateOrRedirect('${rfq.id}')">
          <div class="opportunity-card-grid">
            <div class="opportunity-col-info">
              <span class="opportunity-status-badge ${urgency.badgeClass}">${inGracePeriod ? '🔒 Closed' : urgency.label}</span>
              ${inGracePeriod ? `<span style="font-size:11px; color:var(--warning); margin-left:8px; font-weight:500;">Questions Only</span>` : ''}
              <p class="opportunity-ref">${refCode}</p>
              <h3 style="margin:0 0 6px 0; color:var(--primary);">${rfq.rfq_name}</h3>
              <p style="margin:0 0 8px 0; font-size:12px; text-transform:uppercase; color:var(--border); font-weight:bold; display:flex; align-items:center; gap:8px;">
                ${company && company.logo_url ? `<img src="${company.logo_url}" alt="${company.name}" style="height:${Math.min(cardLogoHeight, 22)}px; width:auto; max-width:${cardLogoMaxWidth}px; object-fit:contain;">` : ''}
                ${company ? company.name : 'RFQ Hub'}
              </p>
              <p style="margin:0; color:var(--ink); font-size:14px;">${rfq.description}</p>
            </div>
            <div class="opportunity-col-meta">
              <div class="opportunity-meta-row">${ICON_CALENDAR}<div><span class="opportunity-meta-label">Closing Date</span>${deadlineDate.toLocaleDateString()} at ${deadlineDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div></div>
              ${locationText ? `<div class="opportunity-meta-row">${ICON_PIN}<div><span class="opportunity-meta-label">Location</span>${locationText}</div></div>` : ''}
              <div class="opportunity-meta-row">${ICON_TAG}<div><span class="opportunity-meta-label">Project</span>${rfq.project_name}</div></div>
            </div>
            <div class="opportunity-col-countdown">
              <div class="countdown-box">
                <p class="countdown-urgency-label ${urgency.status}">${inGracePeriod ? 'Closed' : (urgency.status === 'closed' ? 'Closed' : 'Closing In')}</p>
                <div class="countdown-units" data-deadline="${rfq.deadline}">
                  <div><div class="countdown-unit-num cd-days">--</div><div class="countdown-unit-label">Days</div></div>
                  <div><div class="countdown-unit-num cd-hrs">--</div><div class="countdown-unit-label">Hrs</div></div>
                  <div><div class="countdown-unit-num cd-mins">--</div><div class="countdown-unit-label">Mins</div></div>
                </div>
                ${inGracePeriod ? `
                  <p style="font-size:11px; color:var(--border); margin:10px 0; text-align:center;">Applications closed. Questions accepted for 3 days.</p>
                ` : `
                  <button type="button" class="btn navy" style="width:100%; padding:10px; margin-top:14px;" onclick="event.stopPropagation(); openApplicantGateOrRedirect('${rfq.id}')">View Opportunity →</button>
                `}
                <button type="button" class="btn secondary" style="width:100%; padding:10px; margin-top:${inGracePeriod ? '8px' : '8px'};" ${gracePeriodExpired ? 'disabled' : ''} onclick="event.stopPropagation(); openAskQuestionModal('${rfq.id}', '${escapeHtmlClient(rfq.rfq_name).replace(/'/g, "\\'")}')">❓ Ask for more information</button>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');

    updateAllCountdowns();
    ensureCountdownTicking();
  } catch (err) {
    console.error('Error loading public RFQ list:', err);
    listEl.innerHTML = '<p style="color:var(--warning);">Error loading open RFQs.</p>';
  }
}

// Real, already-public data only: companies that currently have at least
// one open RFQ listed and a logo on file. No invented organisations.
function renderOrgLogos(companiesById) {
  const section = document.getElementById('org-logos-section');
  const grid = document.getElementById('org-logos-grid');
  if (!section || !grid) return;

  const withLogos = Object.values(companiesById).filter(c => c && c.logo_url);
  if (withLogos.length === 0) {
    section.style.display = 'none';
    grid.innerHTML = '';
    return;
  }

  grid.innerHTML = withLogos.map(c => `<img src="${c.logo_url}" alt="${c.name}" title="${c.name}">`).join('');
  section.style.display = 'block';
}

// Narrow aggregate-only stats (see get_public_portal_stats RPC) — real
// counts, never invented. Any stat that's currently zero is omitted
// rather than shown as "0 X", and the whole row stays hidden if the call
// fails or every count is zero.
async function loadPublicPortalStats() {
  const row = document.getElementById('hero-stats-row');
  if (!row) return;
  row.style.display = 'none';
  row.innerHTML = '';

  try {
    const { data, error } = await client.rpc('get_public_portal_stats');
    if (error) throw error;
    const stats = Array.isArray(data) ? data[0] : data;
    if (!stats) return;

    const items = [
      { num: stats.open_opportunities, label: 'Open Opportunities' },
      { num: stats.registered_suppliers, label: 'Registered Suppliers' },
      { num: stats.organisations, label: 'Organisations' }
    ].filter(item => Number(item.num) > 0);

    if (items.length === 0) return;

    row.innerHTML = items.map(item => `
      <div class="hero-stat">
        <div class="hero-stat-num">${item.num}</div>
        <div class="hero-stat-label">${item.label}</div>
      </div>
    `).join('');
    row.style.display = 'flex';
  } catch (err) {
    console.warn('Could not load public portal stats:', err);
  }
}

// ===== APPLICANT REGISTRATION GATE =====
// Anyone browsing the public "Open RFQs" list must be a registered
// applicant before they can view an RFQ's details or apply. We check
// their email against the applicant_registrations table via a narrow,
// SECURITY DEFINER RPC that only ever returns true/false — it never
// exposes any applicant's data to the public. If the email isn't on
// file, we collect a quick registration first.
let pendingGateRfqId = null;
// Status of the applicant who most recently passed the gate — { status,
// status_reason } or null if unknown/active. Suspended/removed suppliers
// can still browse/view RFQs (per Brent's explicit instruction) but the
// contractor submission form uses this to warn them upfront and disable
// the Submit button, backed by a hard DB-level block either way (see the
// rfq_submissions insert policy) so this is a UX convenience, not the
// actual enforcement.
let currentApplicantStatus = null;

// Populated once a visitor is confirmed registered (either by matching an
// existing email or by completing registration on the spot) — feeds the
// "reuse a document already on file" choice on the RFQ application form.
// currentApplicantDocuments mirrors the shape returned by the
// get_my_supplier_documents RPC: { has_cipc, cipc_file_name,
// has_proof_of_address, proof_of_address_file_name, has_sars, sars_file_name }.
let currentApplicantEmail = null;
let currentApplicantDocuments = null;

// Kept as a named wrapper so existing onclick handlers keep working.
function openApplicantGateOrRedirect(rfqId) {
  openApplicantGate(rfqId);
}

function openApplicantGate(rfqId) {
  // If registration privacy hasn't been accepted yet, show it first
  if (!registrationPrivacyAccepted) {
    pendingGateRfqIdAfterPrivacy = rfqId;
    // Update company name in privacy modal (or default to "the Company" if not applicable)
    const companyNameEl = document.getElementById('privacy-company-name');
    if (companyNameEl && currentCompany && currentCompany.company_name) {
      companyNameEl.textContent = currentCompany.company_name;
    }
    openModal('registration-privacy-modal');
    return;
  }

  pendingGateRfqId = rfqId;

  // Reset every field on the gate — both the quick email step and the full
  // Supplier Database registration form (name/company/contact/address/
  // services/documents/declaration) — so a previous attempt never bleeds
  // into a fresh one.
  const fieldIds = [
    'gate-email', 'gate-company-name', 'gate-years-business', 'gate-full-name',
    'gate-title', 'gate-designation', 'gate-phone', 'gate-additional-phone',
    'gate-address', 'gate-province', 'gate-website', 'gate-services-description',
    'gate-service-areas'
  ];
  fieldIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const fileIds = [
    'gate-doc-cipc', 'gate-doc-proof-address', 'gate-doc-sars', 'gate-doc-banking',
    'gate-doc-bbbee', 'gate-doc-health-safety', 'gate-doc-permits', 'gate-doc-other'
  ];
  fileIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const declarationEl = document.getElementById('gate-declaration-accept');
  if (declarationEl) declarationEl.checked = false;
  currentApplicantStatus = null;
  currentApplicantEmail = null;
  currentApplicantDocuments = null;

  // "Register Free" / "Register as a Supplier" open this same gate with no
  // specific RFQ in mind (rfqId is null) — swap the copy so it reads as a
  // general supplier registration rather than implying a specific RFQ.
  const titleEl = document.getElementById('gate-modal-title');
  const introEl = document.getElementById('gate-modal-intro');
  if (titleEl) titleEl.textContent = rfqId ? 'Register to View & Apply' : 'Register as a Supplier';
  if (introEl) introEl.textContent = rfqId
    ? "To view this RFQ's details and apply, please confirm your email. It only takes a moment."
    : "Register your email to start browsing and applying to open RFQs. It only takes a moment.";

  document.getElementById('gate-email-section').style.display = 'block';
  document.getElementById('gate-register-section').style.display = 'none';
  closeMobileNav();
  openModal('applicant-gate-modal');
}

function gateBackToEmail() {
  document.getElementById('gate-email-section').style.display = 'block';
  document.getElementById('gate-register-section').style.display = 'none';
}

function acceptRegistrationPrivacy() {
  registrationPrivacyAccepted = true;
  const rfqId = pendingGateRfqIdAfterPrivacy;
  closeModal('registration-privacy-modal');
  openApplicantGate(rfqId);
}

function acceptApplicationPrivacy() {
  applicationPrivacyAccepted = true;
  const token = window.pendingSubmitToken;
  closeModal('application-privacy-modal');
  if (token) {
    submitContractorForm(token);
  }
}

async function handleGateEmailSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('gate-email').value.trim();
  if (!email) return;

  const submitBtn = document.getElementById('gate-email-submit');
  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Checking...';

  try {
    const { data: isRegistered, error } = await client.rpc('check_applicant_registered', { p_email: email });
    if (error) throw error;

    if (isRegistered) {
      // Best-effort — used only to warn/disable-apply in the RFQ view
      // below, never to block viewing itself. A failure here shouldn't
      // stop an otherwise-fine registered visitor from proceeding.
      currentApplicantStatus = null;
      try {
        const { data: statusRows } = await client.rpc('check_applicant_status', { p_email: email });
        currentApplicantStatus = (statusRows && statusRows[0]) || null;
      } catch (statusErr) {
        console.warn('Could not check applicant status:', statusErr.message);
      }

      // Also best-effort: which of the 3 mandatory documents does this
      // applicant already have on file? Feeds the "use document on file"
      // offer on the RFQ application form below — never required, so a
      // failure here just means everyone re-uploads as before.
      currentApplicantEmail = email;
      currentApplicantDocuments = null;
      try {
        const { data: docRows } = await client.rpc('get_my_supplier_documents', { p_email: email });
        currentApplicantDocuments = (docRows && docRows[0]) || null;
      } catch (docsErr) {
        console.warn('Could not fetch documents on file:', docsErr.message);
      }

      if (currentApplicantStatus && currentApplicantStatus.status === 'suspended') {
        showToast('⚠️ Your supplier registration is suspended. You can view RFQs but can\'t apply — contact us for details.', 'error');
      } else if (currentApplicantStatus && currentApplicantStatus.status === 'removed') {
        showToast('⚠️ Your supplier registration has been removed. You can view RFQs but can\'t apply — contact us for details.', 'error');
      } else {
        showToast(pendingGateRfqId ? '👋 Welcome back! Loading RFQ...' : '👋 Welcome back! You\'re already registered.', 'success');
      }
      proceedPastGate();
    } else {
      document.getElementById('gate-email-section').style.display = 'none';
      document.getElementById('gate-register-section').style.display = 'block';
    }
  } catch (err) {
    console.error('Error checking registration:', err);
    showToast('❌ Could not check registration. Please try again.', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  }
}

// Supabase Storage's S3-compatible backend rejects object keys built
// from a raw, uncontrolled file.name — accented/non-ASCII characters
// (e.g. "é") in particular come back as "Invalid key: ...". Strips
// diacritics down to their base ASCII letter (é -> e) and replaces
// anything else outside [A-Za-z0-9._-] with a dash, so the human-
// readable name stays recognizable (still needed by get_my_documents()/
// get_my_supplier_documents(), which recover it by stripping the known
// "<prefix>-<timestamp>-" header back off the stored path) while the
// key itself is guaranteed storage-safe.
function sanitizeStorageFileName(name) {
  const diacriticRange = String.fromCharCode(0x0300) + '-' + String.fromCharCode(0x036f);
  const diacriticPattern = new RegExp('[' + diacriticRange + ']', 'g');
  const base = String(name || '').normalize('NFKD').replace(diacriticPattern, '');
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[.-]+|[.-]+$/g, '');
  return safe || 'file';
}

// Uploads one supplier registration document to the private
// 'supplier-documents' bucket, folder-scoped by the client-generated
// applicant id so files from different registrants never collide. Returns
// the storage path (not a public URL — the bucket is private and only
// readable by the super admin, same trust model as the table itself).
async function uploadSupplierDocument(applicantId, keyPrefix, file) {
  const filePath = `applicant-${applicantId}/${keyPrefix}-${Date.now()}-${sanitizeStorageFileName(file.name)}`;
  const { error } = await client.storage.from('supplier-documents').upload(filePath, file);
  if (error) throw error;
  return filePath;
}

// Brute-force protection helper
async function checkBruteForce(email, action) {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/check-brute-force`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.toLowerCase(), action })
    });
    return await res.json();
  } catch (err) {
    console.warn('Brute-force check failed:', err);
    return { allowed: true }; // Fail open
  }
}

// Check if an RFQ is in the 3-day grace period after closing
function isInGracePeriod(deadline) {
  const now = new Date();
  const deadlineDate = new Date(deadline);
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

  return deadlineDate <= now && deadlineDate > threeDaysAgo;
}

// Check if an RFQ has passed the 3-day grace period
function isGracePeriodExpired(deadline) {
  const now = new Date();
  const deadlineDate = new Date(deadline);
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

  return deadlineDate <= threeDaysAgo;
}

async function handleGateRegisterSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('gate-email').value.trim();

  // Check if account is locked due to failed registration attempts
  const bruteForceCheck = await checkBruteForce(email, 'check');
  if (!bruteForceCheck.allowed) {
    showToast(`❌ ${bruteForceCheck.message}`, 'error');
    return;
  }
  const companyName = document.getElementById('gate-company-name').value.trim();
  const yearsInBusiness = document.getElementById('gate-years-business').value.trim();
  const fullName = document.getElementById('gate-full-name').value.trim();
  const title = document.getElementById('gate-title').value;
  const designation = document.getElementById('gate-designation').value.trim();
  const phone = document.getElementById('gate-phone').value.trim();
  const additionalPhone = document.getElementById('gate-additional-phone').value.trim();
  const address = document.getElementById('gate-address').value.trim();
  const provinceEl = document.getElementById('gate-province');
  const province = provinceEl ? provinceEl.value : '';
  const website = document.getElementById('gate-website').value.trim();
  const servicesDescription = document.getElementById('gate-services-description').value.trim();
  const serviceAreas = document.getElementById('gate-service-areas').value.trim();
  const declarationAccepted = document.getElementById('gate-declaration-accept').checked;

  const cipcFile = document.getElementById('gate-doc-cipc').files[0];
  const proofAddressFile = document.getElementById('gate-doc-proof-address').files[0];
  const sarsFile = document.getElementById('gate-doc-sars').files[0];
  const bankingFile = document.getElementById('gate-doc-banking').files[0];
  const bbbeeFile = document.getElementById('gate-doc-bbbee').files[0];
  const healthSafetyFile = document.getElementById('gate-doc-health-safety').files[0];
  const permitsFile = document.getElementById('gate-doc-permits').files[0];
  const otherFiles = Array.from(document.getElementById('gate-doc-other').files || []);

  // The form's own `required` attributes already block submission for most
  // of these (native HTML5 validation), but the email field belongs to the
  // earlier step's form, not this one, so it's not covered by that — worth
  // a defensive check. A couple of others are double-checked too since a
  // clear error here beats a confusing DB constraint failure below.
  if (!email || !companyName || !fullName) {
    showToast('❌ Please fill in your email, company name and main contact person.', 'error');
    return;
  }
  if (!province) {
    showToast('❌ Please select a province (or "All Provinces") so we know what to notify you about.', 'error');
    return;
  }
  if (!cipcFile || !proofAddressFile || !sarsFile) {
    showToast('❌ Please upload CIPC Registration/ID, Proof of Address, and SARS Information — these are required.', 'error');
    return;
  }
  if (!declarationAccepted) {
    showToast('❌ Please accept the Declaration to continue.', 'error');
    return;
  }

  const submitBtn = document.getElementById('gate-register-submit');
  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Uploading documents...';

  // Generate the row's id client-side (same pattern used for rfq_submissions
  // and rfq_questions) so uploaded files can be folder-scoped to it before
  // the row exists, and so we never need to chain .select() onto the insert
  // below — applicant_registrations' SELECT policy is super-admin-only, so
  // an anonymous registrant reading the row back via RETURNING would 401.
  const applicantId = generateUUID();

  try {
    const [cipcPath, proofAddressPath, sarsPath] = await Promise.all([
      uploadSupplierDocument(applicantId, 'cipc', cipcFile),
      uploadSupplierDocument(applicantId, 'proof-of-address', proofAddressFile),
      uploadSupplierDocument(applicantId, 'sars', sarsFile)
    ]);

    // Optional documents: upload what was provided, but don't let a single
    // optional-upload failure block the whole registration — the required
    // documents above already succeeded, so log and continue.
    const uploadOptional = async (file, key) => {
      if (!file) return null;
      try {
        return await uploadSupplierDocument(applicantId, key, file);
      } catch (err) {
        console.warn(`⚠️ Optional document "${key}" failed to upload:`, err.message);
        return null;
      }
    };
    const [bankingPath, bbbeePath, healthSafetyPath, permitsPath] = await Promise.all([
      uploadOptional(bankingFile, 'banking'),
      uploadOptional(bbbeeFile, 'bbbee'),
      uploadOptional(healthSafetyFile, 'health-safety'),
      uploadOptional(permitsFile, 'permits')
    ]);

    const otherDocuments = [];
    for (const file of otherFiles) {
      const path = await uploadOptional(file, 'other');
      if (path) otherDocuments.push({ name: file.name, path });
    }

    submitBtn.textContent = 'Registering...';

    const { error } = await client
      .from('applicant_registrations')
      .insert({
        id: applicantId,
        full_name: fullName,
        company_name: companyName,
        email,
        phone: phone || null,
        province,
        years_in_business: parseInt(yearsInBusiness, 10) || 0,
        title,
        designation,
        additional_phone: additionalPhone || null,
        address,
        website_social: website || null,
        services_description: servicesDescription,
        service_areas: serviceAreas,
        declaration_accepted: declarationAccepted,
        cipc_document_path: cipcPath,
        proof_of_address_document_path: proofAddressPath,
        sars_document_path: sarsPath,
        proof_of_banking_document_path: bankingPath,
        bbbee_document_path: bbbeePath,
        health_safety_document_path: healthSafetyPath,
        special_permits_document_path: permitsPath,
        other_documents: otherDocuments
      });
    // A duplicate email (e.g. a race with another tab, or someone
    // double-submitting) isn't a real problem here — they're registered
    // either way, so let them through rather than showing an error.
    if (error && error.code !== '23505') {
      // Record failed registration attempt for brute-force protection
      await checkBruteForce(email, 'fail');
      throw error;
    }

    // The 3 mandatory documents were just uploaded above, so we already
    // know they're on file — no need for a round-trip to
    // get_my_supplier_documents to populate the same "reuse on file"
    // offer the RFQ application form uses for a returning applicant.
    currentApplicantEmail = email;
    currentApplicantDocuments = {
      has_cipc: true,
      cipc_file_name: cipcFile.name,
      has_proof_of_address: true,
      proof_of_address_file_name: proofAddressFile.name,
      has_sars: true,
      sars_file_name: sarsFile.name
    };

    // Fetch the assigned supplier number (with a small delay to ensure database commit)
    let supplierNumberMsg = '';
    try {
      // Wait 500ms for the database to fully commit the registration
      await new Promise(resolve => setTimeout(resolve, 500));

      const supplierRes = await fetch(`${SUPABASE_URL}/functions/v1/get-supplier-number?email=${encodeURIComponent(email)}`);
      if (supplierRes.ok) {
        const supplierData = await supplierRes.json();
        if (supplierData.supplierNumber) {
          supplierNumberMsg = ` Your supplier number is <strong>${supplierData.supplierNumber}</strong>.`;
        }
      }
    } catch (err) {
      console.warn('Could not fetch supplier number:', err);
    }

    // Reset brute-force attempts on successful registration
    await checkBruteForce(email, 'success');

    // Best-effort registration confirmation — the supplier is registered
    // either way, so a Resend hiccup shouldn't surface to them as a failure.
    // Deliberately sends only the email address: the Edge Function looks the
    // registration up itself and mails the address on that row, so nothing
    // here can be used to send mail to an arbitrary recipient. It also sends
    // at most once per registration, so a double-submit can't double-mail.
    // This is what puts the supplier number in writing — until now it existed
    // only in the toast below, which disappears after a few seconds.
    callPublicEdgeFunction('send-registration-confirmation', { email })
      .catch(err => console.error('send-registration-confirmation failed:', err));

    showToast(pendingGateRfqId ? `✅ Registered! Check your email for your supplier number. Loading RFQ...` : `✅ You're registered!${supplierNumberMsg} We've emailed you a confirmation.`, 'success');
    proceedPastGate();
  } catch (err) {
    console.error('Error registering applicant:', err);
    showToast('❌ Registration failed: ' + err.message, 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  }
}

function proceedPastGate() {
  closeModal('applicant-gate-modal');
  const rfqId = pendingGateRfqId;
  pendingGateRfqId = null;
  if (!rfqId) {
    // Generic "Register Free" / "Register as a Supplier" — nothing to
    // open, just take them to the listings they can now apply to.
    const listEl = document.getElementById('public-rfq-list');
    if (listEl) listEl.scrollIntoView({ behavior: 'smooth' });
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.set('open', rfqId);
  window.history.replaceState({}, '', url);
  loadOpenRFQView(rfqId);
}

// ===== RFQ QUESTIONS & ANSWERS =====
// Deliberately its own self-contained modal (own email/name fields) rather
// than reusing the applicant-gate flow — contractors should be able to ask
// a quick question without registering, and this avoids any risk of
// disturbing the already-working gate/registration logic above.
function openAskQuestionModal(rfqId, rfqName) {
  // Check if the grace period has expired for this RFQ
  if (currentRFQData && isGracePeriodExpired(currentRFQData.deadline)) {
    showToast('This RFQ closed more than 3 days ago. Questions are no longer accepted.', 'error');
    return;
  }

  pendingAskQuestionRfqId = rfqId;
  const nameEl = document.getElementById('ask-question-rfq-name');
  if (nameEl) nameEl.textContent = rfqName || '';
  const form = document.getElementById('ask-question-form');
  if (form) form.reset();
  closeMobileNav();
  openModal('ask-question-modal');
}

async function handleAskQuestionSubmit(e) {
  e.preventDefault();
  if (!pendingAskQuestionRfqId) return;

  const email = document.getElementById('ask-question-email').value.trim();
  const name = document.getElementById('ask-question-name').value.trim();
  const question = document.getElementById('ask-question-text').value.trim();

  if (!email || !question) {
    showToast('❌ Please enter your email and a question.', 'error');
    return;
  }

  const submitBtn = document.getElementById('ask-question-submit');
  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Sending...';

  try {
    // Generate the id client-side (same pattern as submitContractorForm's
    // submissionId) rather than using .select() to read the row back after
    // insert. The asker is unauthenticated and rfq_questions' SELECT policy
    // is scoped to the RFQ's own company/super-admin only, so a post-insert
    // .select() has no RLS permission to read the row back and fails with a
    // 401 — the row is still inserted, but the client never sees it.
    const questionId = generateUUID();

    const { error } = await client
      .from('rfq_questions')
      .insert({
        id: questionId,
        rfq_id: pendingAskQuestionRfqId,
        applicant_email: email,
        applicant_name: name || null,
        question
      });

    if (error) throw error;

    showToast('✅ Your question has been sent.', 'success');
    closeModal('ask-question-modal');

    // Best-effort staff notification — the question is already saved either
    // way, so a failure here (e.g. no contact email on file, Resend hiccup)
    // shouldn't be shown to the asker as an error.
    callPublicEdgeFunction('notify-new-rfq-question', { questionId })
      .catch(err => console.error('notify-new-rfq-question failed:', err));
  } catch (err) {
    console.error('Error submitting question:', err);
    showToast('❌ Could not send your question: ' + err.message, 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  }
}

function openAnswerQuestionModal(questionId) {
  pendingAnswerQuestionId = questionId;
  const textEl = document.getElementById('answer-question-text');
  // Looked up from the map built while rendering the RFQ Console rather
  // than passed inline through onclick, since question text is free-form
  // (can contain quotes/newlines) and unsafe to embed in an HTML attribute.
  if (textEl) textEl.textContent = (rfqQuestionsById[questionId] && rfqQuestionsById[questionId].question) || '';
  const form = document.getElementById('answer-question-form');
  if (form) form.reset();
  openModal('answer-question-modal');
}

async function handleAnswerQuestionSubmit(e) {
  e.preventDefault();
  if (!pendingAnswerQuestionId) return;

  const answer = document.getElementById('answer-question-response').value.trim();
  const visibilityInput = document.querySelector('input[name="answer-visibility"]:checked');
  const visibility = visibilityInput ? visibilityInput.value : 'public';

  if (!answer) {
    showToast('❌ Please enter an answer.', 'error');
    return;
  }

  const submitBtn = document.getElementById('answer-question-submit');
  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Sending...';

  try {
    await callEdgeFunction('answer-rfq-question', {
      questionId: pendingAnswerQuestionId,
      answer,
      visibility
    });

    showToast('✅ Answer sent.', 'success');
    closeModal('answer-question-modal');
    pendingAnswerQuestionId = null;
    loadRFQConsole();
  } catch (err) {
    console.error('Error sending answer:', err);
    showToast('❌ Could not send answer: ' + err.message, 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  }
}

// Unpublishing removes an Open RFQ from the public portal (listing, direct
// links, and the applicant gate) without deleting anything — submissions
// already received stay intact and reviewable, and the RFQ can be
// republished once whatever prompted the unpublish (e.g. an error in the
// listing) is fixed. The real enforcement is the rfqs_select_scoped RLS
// policy (is_public = true AND is_withdrawn = false); this update is what
// flips that gate.
async function unpublishRFQ(rfqId) {
  if (!confirm('Unpublish this RFQ from the public portal? It will no longer be visible or reachable by contractors browsing or with a direct link. Submissions already received are kept, and you can republish it later.')) return;

  try {
    const { error } = await client
      .from('rfqs')
      .update({ is_withdrawn: true, withdrawn_at: new Date().toISOString() })
      .eq('id', rfqId);
    if (error) throw error;
    showToast('✅ RFQ unpublished — no longer visible on the public portal.', 'success');
    loadRFQConsole();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

async function republishRFQ(rfqId) {
  if (!confirm('Republish this RFQ? It will become visible on the public portal again.')) return;

  try {
    const { error } = await client
      .from('rfqs')
      .update({ is_withdrawn: false, withdrawn_at: null })
      .eq('id', rfqId);
    if (error) throw error;
    showToast('✅ RFQ republished — visible on the public portal again.', 'success');
    loadRFQConsole();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

// "Expand Supplier Search" lets staff broaden which provinces' registered
// suppliers get notified about an already-published RFQ, e.g. when the
// original province didn't produce enough applications. Only provinces not
// already in the RFQ's notified_provinces are offered, so nobody already
// notified gets a duplicate email/SMS.
function openExpandSearchModal(rfqId, notifiedProvincesJson) {
  pendingExpandSearchRfqId = rfqId;
  let notified = [];
  try { notified = JSON.parse(notifiedProvincesJson) || []; } catch { notified = []; }

  const container = document.getElementById('expand-search-provinces');
  const remaining = PROVINCE_OPTIONS.filter(p => !notified.includes(p));

  if (remaining.length === 0) {
    container.innerHTML = '<p style="margin:0; color:var(--border); font-style:italic;">All provinces have already been notified for this RFQ.</p>';
    document.getElementById('expand-search-submit').style.display = 'none';
  } else {
    document.getElementById('expand-search-submit').style.display = '';
    container.innerHTML = remaining.map(p => `
      <label style="font-weight:normal; display:flex; align-items:center; gap:8px;">
        <input type="checkbox" name="expand-province" value="${p}">
        <span>${p}</span>
      </label>
    `).join('');
  }

  openModal('expand-search-modal');
}

async function handleExpandSearchSubmit(e) {
  e.preventDefault();
  if (!pendingExpandSearchRfqId) return;

  const additionalProvinces = Array.from(document.querySelectorAll('input[name="expand-province"]:checked')).map(el => el.value);
  if (additionalProvinces.length === 0) {
    showToast('❌ Select at least one province.', 'error');
    return;
  }

  const submitBtn = document.getElementById('expand-search-submit');
  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Notifying...';

  try {
    const result = await callEdgeFunction('notify-suppliers-new-rfq', {
      rfqId: pendingExpandSearchRfqId,
      additionalProvinces
    });

    const parts = [];
    if (result.sent > 0) parts.push(`${result.sent} emailed`);
    if (result.smsSent > 0) parts.push(`${result.smsSent} texted`);
    if (parts.length > 0) {
      showToast(`✅ Notified suppliers in ${additionalProvinces.join(', ')} (${parts.join(', ')})`, 'success');

      // Update the supplier count in the database by adding the new notified suppliers
      const newSuppliersCount = result.sent || 0;
      const { data: currentRfq } = await client
        .from('rfqs')
        .select('supplier_count_notified')
        .eq('id', pendingExpandSearchRfqId)
        .single();

      const currentCount = currentRfq?.supplier_count_notified || 0;
      const updatedCount = currentCount + newSuppliersCount;

      const { error: updateError } = await client
        .from('rfqs')
        .update({ supplier_count_notified: updatedCount })
        .eq('id', pendingExpandSearchRfqId);

      if (updateError) {
        console.warn('Could not update supplier count:', updateError);
      }
    } else if (result.alreadyNotified) {
      showToast('Those provinces were already notified for this RFQ.', 'info');
    } else {
      showToast('No registered suppliers found in the selected province(s) yet.', 'info');
    }
    if (result.smsError) {
      showToast('Note: SMS notifications for the new province(s) did not go out — ' + result.smsError, 'warning');
    }

    closeModal('expand-search-modal');
    pendingExpandSearchRfqId = null;
    loadRFQConsole();
  } catch (err) {
    console.error('Error expanding supplier search:', err);
    showToast('❌ Could not notify additional provinces: ' + err.message, 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  }
}

function showLoginForm() {
  hideAllTopLevelViews();
  document.getElementById('public-view').style.display = 'block';
  hideAllPublicSections();
  document.getElementById('login-section').style.display = 'block';
  setHeaderActions('form');
  // The marketplace hero copy ("Find Your Next Business Opportunity...")
  // is only meant for the public landing page — reset it back to the
  // neutral default so it doesn't linger behind the login card when
  // someone clicks "Sign In" straight off the landing page.
  applyDefaultBranding();
}

function showSetPasswordView() {
  hideAllTopLevelViews();
  document.getElementById('public-view').style.display = 'block';
  hideAllPublicSections();
  document.getElementById('set-password-section').style.display = 'block';

  // Same form/flow (client.auth.updateUser({ password })) handles both a
  // brand-new invited account and an existing account resetting a
  // forgotten password — only the copy needs to differ.
  const heading = document.getElementById('set-password-heading');
  const subtext = document.getElementById('set-password-subtext');
  if (currentAuthType === 'recovery') {
    if (heading) heading.textContent = 'Reset Your Password';
    if (subtext) subtext.textContent = 'Choose a new password for your account.';
  } else {
    if (heading) heading.textContent = 'Choose a Password';
    if (subtext) subtext.textContent = "You've been invited to RFQ Hub. Set a password to finish setting up your account.";
  }

  setHeaderActions('form');
  applyDefaultBranding();
}

function showForgotPasswordView() {
  hideAllTopLevelViews();
  document.getElementById('public-view').style.display = 'block';
  hideAllPublicSections();
  document.getElementById('forgot-password-section').style.display = 'block';
  document.getElementById('forgot-password-sent-note').style.display = 'none';
  const form = document.getElementById('forgot-password-form');
  if (form) form.style.display = 'flex';
  const codeForm = document.getElementById('reset-code-form');
  if (codeForm) {
    codeForm.style.display = 'none';
    codeForm.reset();
  }
  setHeaderActions('form');
  applyDefaultBranding();
}

function showSupplierForgotPasswordView() {
  openModal('supplier-forgot-password-modal');
  document.getElementById('supplier-forgot-password-form').style.display = 'flex';
  document.getElementById('supplier-forgot-password-sent-note').style.display = 'none';
  const codeForm = document.getElementById('supplier-reset-code-form');
  if (codeForm) {
    codeForm.style.display = 'none';
    codeForm.reset();
  }
}

// ===== BRANDING =====
async function loadPlatformSettings() {
  try {
    const { data, error } = await client
      .from('platform_settings')
      .select('logo_url, logo_scale')
      .eq('id', 1)
      .maybeSingle();
    if (!error && data) {
      platformSettings = data;
    }
  } catch (err) {
    console.warn('Could not load platform settings:', err);
  }
}

function updateFooterCompanyName(name) {
  const el = document.getElementById('footer-company-name');
  if (el) el.textContent = name || 'RFQ Hub';
}

// Base header logo size at 100% scale. A company/platform's logo_scale
// (0.5–1.5, enforced server-side too) multiplies both dimensions so a
// wide wordmark still keeps its aspect ratio via object-fit:contain.
const BASE_LOGO_HEIGHT = 84;
const BASE_LOGO_MAX_WIDTH = 260;

function applyLogoScale(imgEl, scale) {
  const s = Math.min(1.5, Math.max(0.5, Number(scale) || 1));
  imgEl.style.height = `${Math.round(BASE_LOGO_HEIGHT * s)}px`;
  imgEl.style.maxWidth = `${Math.round(BASE_LOGO_MAX_WIDTH * s)}px`;
}

// The very top masthead (logo + title + subtitle) is platform-level
// branding — it always shows the platform's own logo (set on the Platform
// Branding tab) and "RFQ Hub", regardless of which company's
// dashboard or public RFQ page is currently showing. Company-specific
// branding only appears further down the page (hero section, dashboard
// header bar, footer).
function applyPlatformMasthead() {
  document.getElementById('brand-title').textContent = 'RFQ Hub';
  document.getElementById('brand-subtitle').textContent = 'Request for Quotation Management System';

  const img = document.getElementById('brand-logo-img');
  const def = document.getElementById('brand-logo-default');
  if (platformSettings && platformSettings.logo_url) {
    applyLogoScale(img, platformSettings.logo_scale);
    img.src = platformSettings.logo_url;
    img.style.display = 'block';
    def.style.display = 'none';
  } else {
    img.style.display = 'none';
    def.style.display = 'block';
  }
}

function applyDefaultBranding() {
  applyPlatformMasthead();
  document.getElementById('hero-title').textContent = 'RFQ Hub';
  document.getElementById('hero-subtitle').textContent = DEFAULT_HERO_SUBTITLE;
  updateFooterCompanyName('RFQ Hub');
}

function applyCompanyBranding(company, opts = {}) {
  if (!company) { applyDefaultBranding(); return; }

  applyPlatformMasthead();
  document.getElementById('hero-title').textContent = opts.heroTitle || company.name || 'RFQ Hub';
  document.getElementById('hero-subtitle').textContent = opts.heroSubtitle || DEFAULT_HERO_SUBTITLE;
  updateFooterCompanyName(company.name);
}

// ===== AUTH =====
async function handleLoginSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  if (!email || !password) return;

  try {
    // Check brute-force protection before attempting login
    const bruteForceCheck = await checkBruteForce(email, 'check');
    if (!bruteForceCheck.allowed) {
      const timeRemaining = bruteForceCheck.timeRemainingSeconds || 3600;
      const minutes = Math.ceil(timeRemaining / 60);
      showToast(`Too many failed login attempts. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, 'error');
      return;
    }

    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;

    // Reset failed attempts on successful login
    await checkBruteForce(email, 'success');
    currentUser = data.user;
    showToast('Welcome back!', 'success');
    await loadCurrentCompanyAndRoute(false);
  } catch (err) {
    // Record failed login attempt
    await checkBruteForce(email, 'fail');
    console.error('Login error:', err);
    showToast('Login failed: ' + err.message, 'error');
  }
}

// Deliberately shows the same "check your inbox" message whether or not the
// email actually has an account — same reasoning Supabase's own API follows
// by default: telling an unauthenticated visitor "no account exists for that
// email" lets them enumerate who's registered. Only a genuine send failure
// (bad request, rate limit, etc.) surfaces as an error.
async function handleForgotPasswordSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('forgot-password-email').value.trim();
  if (!email) return;

  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  try {
    // redirectTo is kept for completeness (some Supabase email templates
    // include the link alongside the code), but the flow below relies on
    // the 6-digit {{ .Token }} code, not this link, to sidestep email
    // security scanners pre-fetching and burning single-use links.
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: SITE_URL });
    if (error) throw error;
  } catch (err) {
    console.error('Reset password error:', err);
    showToast('Error: ' + err.message, 'error');
    if (submitBtn) submitBtn.disabled = false;
    return;
  }

  passwordResetEmail = email;
  document.getElementById('forgot-password-form').style.display = 'none';
  document.getElementById('forgot-password-sent-note').style.display = 'block';
  const codeForm = document.getElementById('reset-code-form');
  if (codeForm) codeForm.style.display = 'flex';
  if (submitBtn) submitBtn.disabled = false;
}

async function handleResetCodeSubmit(e) {
  e.preventDefault();

  if (!passwordResetEmail) {
    showToast('Please request a new code first.', 'error');
    showForgotPasswordView();
    return;
  }

  const code = document.getElementById('reset-code-token').value.trim();
  const password = document.getElementById('reset-code-new-password').value;
  const confirmPassword = document.getElementById('reset-code-confirm-password').value;

  if (!/^\d{6}$/.test(code)) {
    showToast('Enter the 6-digit code from your email', 'error');
    return;
  }
  if (password.length < 6) {
    showToast('Password must be at least 6 characters', 'error');
    return;
  }
  if (password !== confirmPassword) {
    showToast('Passwords do not match', 'error');
    return;
  }

  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  try {
    // Redeeming the code (rather than clicking a link) authenticates the
    // recipient directly — there's no intermediate link for an email
    // scanner to pre-fetch and burn before the real person acts.
    const { error: verifyError } = await client.auth.verifyOtp({
      email: passwordResetEmail,
      token: code,
      type: 'recovery',
    });
    if (verifyError) throw verifyError;

    const { error: updateError } = await client.auth.updateUser({ password });
    if (updateError) throw updateError;

    passwordResetEmail = null;
    showToast('✅ Password reset! You can now log in.', 'success');
    showLoginForm();
  } catch (err) {
    console.error('Reset code error:', err);
    showToast('Error: ' + err.message, 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

// ===== SUPPLIER PASSWORD RESET =====
async function handleSupplierForgotPasswordSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('supplier-forgot-password-email').value.trim();
  if (!email) return;

  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  try {
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: SITE_URL });
    if (error) throw error;
  } catch (err) {
    console.error('Supplier reset password error:', err);
    showToast('Error: ' + err.message, 'error');
    if (submitBtn) submitBtn.disabled = false;
    return;
  }

  supplierPasswordResetEmail = email;
  document.getElementById('supplier-forgot-password-form').style.display = 'none';
  document.getElementById('supplier-forgot-password-sent-note').style.display = 'block';
  const codeForm = document.getElementById('supplier-reset-code-form');
  if (codeForm) codeForm.style.display = 'flex';
  if (submitBtn) submitBtn.disabled = false;
}

async function handleSupplierResetCodeSubmit(e) {
  e.preventDefault();

  if (!supplierPasswordResetEmail) {
    showToast('Please request a new code first.', 'error');
    showSupplierForgotPasswordView();
    return;
  }

  const code = document.getElementById('supplier-reset-code-token').value.trim();
  const password = document.getElementById('supplier-reset-code-new-password').value;
  const confirmPassword = document.getElementById('supplier-reset-code-confirm-password').value;

  if (!/^\d{6}$/.test(code)) {
    showToast('Enter the 6-digit code from your email', 'error');
    return;
  }
  if (password.length < 6) {
    showToast('Password must be at least 6 characters', 'error');
    return;
  }
  if (password !== confirmPassword) {
    showToast('Passwords do not match', 'error');
    return;
  }

  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  try {
    const { error: verifyError } = await client.auth.verifyOtp({
      email: supplierPasswordResetEmail,
      token: code,
      type: 'recovery',
    });
    if (verifyError) throw verifyError;

    const { error: updateError } = await client.auth.updateUser({ password });
    if (updateError) throw updateError;

    supplierPasswordResetEmail = null;
    showToast('✅ Password reset! You can now log in with your new password.', 'success');
    closeModal('supplier-forgot-password-modal');
    // Show the applicant gate to let them log in with their new password
    openApplicantGate(null);
  } catch (err) {
    console.error('Supplier reset code error:', err);
    showToast('Error: ' + err.message, 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function handleSetPasswordSubmit(e) {
  e.preventDefault();
  const password = document.getElementById('set-password-new').value;
  const confirmPassword = document.getElementById('set-password-confirm').value;

  if (password.length < 6) {
    showToast('Password must be at least 6 characters', 'error');
    return;
  }
  if (password !== confirmPassword) {
    showToast('Passwords do not match', 'error');
    return;
  }

  try {
    // Clear needs_password_setup (set when the invite was sent — see
    // invite-super-admin/invite-member) now that they've actually set one.
    // updateUser's `data` merges into existing user_metadata rather than
    // replacing it, so this doesn't touch invited_company_id/invited_role.
    const { error } = await client.auth.updateUser({ password, data: { needs_password_setup: false } });
    if (error) throw error;

    // Drop the invite/recovery hash AND query (PKCE's ?code=... lives in
    // the query string, not the hash) so a page refresh doesn't try to
    // re-process an already-used link.
    history.replaceState(null, '', window.location.pathname);

    showToast('✅ Password set!', 'success');
    await loadCurrentCompanyAndRoute(false);
  } catch (err) {
    console.error('Set password error:', err);
    showToast('Error: ' + err.message, 'error');
  }
}

async function handleChangePasswordSubmit(e) {
  return submitPasswordChange(e, 'change-password-new', 'change-password-confirm', 'change-password-form');
}

async function handleSuperChangePasswordSubmit(e) {
  return submitPasswordChange(e, 'super-change-password-new', 'super-change-password-confirm', 'super-change-password-form');
}

async function submitPasswordChange(e, newFieldId, confirmFieldId, formId) {
  e.preventDefault();
  const password = document.getElementById(newFieldId).value;
  const confirmPassword = document.getElementById(confirmFieldId).value;

  if (password.length < 6) {
    showToast('Password must be at least 6 characters', 'error');
    return;
  }
  if (password !== confirmPassword) {
    showToast('Passwords do not match', 'error');
    return;
  }

  try {
    const { error } = await client.auth.updateUser({ password });
    if (error) throw error;
    document.getElementById(formId).reset();
    showToast('✅ Password updated', 'success');
  } catch (err) {
    console.error('Change password error:', err);
    showToast('Error: ' + err.message, 'error');
  }
}

// ===== INVITES =====
async function callEdgeFunction(functionName, payload) {
  const { data: { session } } = await client.auth.getSession();
  if (!session) throw new Error('You must be logged in to do that');

  const response = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`
    },
    body: JSON.stringify(payload)
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `Request failed (${response.status})`);
  }
  return result;
}

async function callInviteFunction(payload) {
  return callEdgeFunction('invite-member', payload);
}

// Like callEdgeFunction, but for Edge Functions meant to be called by an
// unauthenticated caller (e.g. a contractor who just asked a question with
// no login) — no session/Authorization header is required or sent.
async function callPublicEdgeFunction(functionName, payload) {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `Request failed (${response.status})`);
  }
  return result;
}

// Emails each contractor their unique RFQ link via the send-rfq-invites
// Edge Function (Resend). Best-effort: a failure here doesn't undo the RFQ
// or its invitation rows — the links are still shown/copyable as a fallback.
async function sendRFQInviteEmails(rfqId, invitations) {
  const payload = {
    rfqId,
    invitations: invitations.map(inv => ({ email: inv.contractor_email, token: inv.invitation_token }))
  };

  try {
    const result = await callEdgeFunction('send-rfq-invites', payload);
    showToast(`✅ Emailed ${result.sent || invitations.length} contractor(s)`, 'success');
  } catch (err) {
    console.error('Error sending contractor emails:', err);
    showToast('Saved, but emailing contractors failed: ' + err.message, 'warning');
  }
}

// Only ever called from releaseRFQ() (and from showAddContractorForm()'s
// single-contractor add, which is its own always-immediate action) — emails
// every registered supplier whose notification province matches this RFQ's
// province (or who chose "All Provinces"). Best-effort, same as
// sendRFQInviteEmails: a failure here doesn't undo the release itself, it
// just means suppliers won't have been proactively emailed.
async function notifySuppliersNewRFQ(rfqId) {
  try {
    const result = await callEdgeFunction('notify-suppliers-new-rfq', { rfqId });
    const parts = [];
    if (result.sent > 0) parts.push(`${result.sent} emailed`);
    if (result.smsSent > 0) parts.push(`${result.smsSent} texted`);
    if (parts.length > 0) {
      showToast(`✅ Notified registered suppliers in this province (${parts.join(', ')})`, 'success');
    }

    // Store the supplier count in the database for accurate response rate calculation
    const supplierCount = result.sent || 0;
    if (supplierCount > 0) {
      const { error: updateError } = await client
        .from('rfqs')
        .update({ supplier_count_notified: supplierCount })
        .eq('id', rfqId);
      if (updateError) {
        console.warn('Could not store supplier count:', updateError);
      }
    }

    if (result.smsError) {
      // Best-effort second channel — email above may still have gone out fine,
      // so this is a soft warning rather than blocking anything.
      console.error('SMS notification issue:', result.smsError);
      showToast('Note: supplier SMS notifications did not go out — ' + result.smsError, 'warning');
    }
  } catch (err) {
    console.error('Error notifying suppliers:', err);
    showToast('RFQ published, but notifying suppliers failed: ' + err.message, 'warning');
  }
}

// The ONLY action that makes an RFQ actually go out: flips is_released, and
// from that single moment — never from Save/Save Draft/Save Changes —
// triggers whatever "going live" means for this RFQ's visibility: an Open
// RFQ becomes publicly listed and its registered suppliers get emailed/
// texted; a Closed RFQ's contractor invitation links become reachable and
// those contractors get emailed. Brent's explicit requirement (2026-08-24):
// create → edit/re-save (as many times as needed, silently) → release once,
// when ready — for both Open and Closed RFQs. Not offered again once
// is_released is already true (see loadRFQConsole()); further edits after
// that point stay silent, and Unpublish/Republish/Expand Supplier Search
// remain the tools for managing an already-released Open RFQ's visibility
// and notification reach.
// Shared by releaseRFQ() (the Console button) and createNewRFQ() (the
// "🚀 Publish RFQ" button right on the Create/Edit form) — takes an already-
// fetched/saved `rfq` row (must have at least id/is_public) and does the
// actual "go live" work: flips is_released, notifies registered suppliers
// for an Open RFQ, and emails every contractor invitation on file for this
// RFQ (old and brand new alike) that hasn't gone out yet. Doesn't fetch or
// confirm anything itself — callers own that.
async function performRelease(rfq) {
  const updatePayload = { is_released: true, released_at: new Date().toISOString() };
  if (rfq.is_public) {
    // Starting from a clean slate — this RFQ has never been notified before
    // (nothing goes out before release), so these should already be at
    // their defaults, but set them explicitly so notify-suppliers-new-rfq
    // and Expand Search's per-province bookkeeping definitely start clean.
    updatePayload.supplier_notification_sent = false;
    updatePayload.sms_notification_sent = false;
    updatePayload.notified_provinces = [];
  }

  const { error: updateError } = await client
    .from('rfqs')
    .update(updatePayload)
    .eq('id', rfq.id);
  if (updateError) throw updateError;

  if (rfq.is_public) {
    // Fire-and-forget: don't block the rest of the release on this.
    notifySuppliersNewRFQ(rfq.id);
  }

  const { data: invitations } = await client
    .from('rfq_invitations')
    .select('*')
    .eq('rfq_id', rfq.id);
  if (invitations && invitations.length > 0) {
    await sendRFQInviteEmails(rfq.id, invitations);
  }

  return { invitations: invitations || [] };
}

// The Console-card version of "go live": fetches the current row itself and
// confirms before acting, since it's a standalone action not part of a save
// already in progress. See performRelease() above for what actually happens,
// and createNewRFQ()'s "🚀 Publish RFQ" button for the other entry point
// (save-and-release in one step, right from the Create/Edit form).
async function releaseRFQ(rfqId) {
  if (!confirm('Publish this RFQ? This makes it go live: if Open, it becomes publicly listed and registered suppliers are notified by email/SMS; if Closed, its contractor invitation links become active and those contractors are emailed. This cannot be undone by editing alone.')) return;

  try {
    const { data: rfq, error: fetchError } = await client
      .from('rfqs')
      .select('*')
      .eq('id', rfqId)
      .single();
    if (fetchError || !rfq) throw new Error(fetchError ? fetchError.message : 'RFQ not found');
    if (rfq.is_released) {
      showToast('This RFQ has already been published.', 'info');
      return;
    }

    const { invitations } = await performRelease(rfq);

    showToast('🚀 RFQ published' + (rfq.is_public ? ' — going out to registered suppliers now' : (invitations.length > 0 ? ' — inviting contractors now' : '')), 'success');
    loadRFQConsole();
  } catch (err) {
    console.error('❌ Error releasing RFQ:', err);
    showToast('Error: ' + err.message, 'error');
  }
}

async function handleInviteCompanySubmit(e) {
  e.preventDefault();
  const companyName = document.getElementById('invite-company-name').value.trim();
  const email = document.getElementById('invite-company-email').value.trim();

  if (!companyName || !email) {
    showToast('Please fill in both fields', 'error');
    return;
  }

  try {
    showToast('Sending invite...', 'info');
    const accessEl = document.getElementById('invite-company-access');
    await callInviteFunction({ companyName, email, subscriptionStatus: accessEl ? accessEl.value : 'pending_payment' });
    showToast(`✅ Invited ${email} to set up "${companyName}"`, 'success');
    document.getElementById('invite-company-form').reset();
    loadSuperAdminCompanies();
  } catch (err) {
    console.error('Invite company error:', err);
    showToast('Error: ' + err.message, 'error');
  }
}

// Manage Admins: only ever reachable by the admin-manager (see
// isAdminManager / showSuperAdminView) — the Edge Function itself also
// re-checks this server-side, so the tab being hidden for everyone else
// is a UX convenience, not the actual enforcement.
let lastLoadedSuperAdmins = []; // cached so openAdminPermissionsModal can look up an admin's current grants by email without re-fetching or embedding JSON in onclick attributes

const ADMIN_PERMISSION_SECTION_LABELS = {
  invite_company: 'Invite a Company',
  platform_branding: 'Platform Branding',
  companies: 'All Companies',
  applicants: 'Supplier Database'
};

function permissionSummaryText(permissions) {
  const parts = ADMIN_PERMISSION_SECTIONS
    .filter(section => permissions && permissions[section] && (permissions[section].view || permissions[section].edit))
    .map(section => `${ADMIN_PERMISSION_SECTION_LABELS[section]} (${permissions[section].edit ? 'edit' : 'view'})`);
  return parts.length ? parts.join(', ') : 'No sections granted yet';
}

async function loadSuperAdminsList() {
  try {
    const { data: admins, error } = await client
      .from('super_admins')
      .select('*')
      .order('created_at', { ascending: true });

    if (error) throw error;
    lastLoadedSuperAdmins = admins || [];

    const list = document.getElementById('super-admins-list');
    if (!list) return;

    list.innerHTML = (admins || []).map(a => `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:15px; border:1px solid var(--border); border-radius:4px; margin-bottom:10px; flex-wrap:wrap; gap:10px;">
        <div>
          <p style="margin:0; font-weight:600;">${escapeHtmlClient(a.email)} ${a.can_manage_admins ? '<span class="submission-status approved">Owner</span>' : '<span class="submission-status" style="background:var(--bg-2); color:var(--ink); border:1px solid var(--border);">Super Admin</span>'}</p>
          <p style="margin:2px 0 0 0; font-size:12px; color:var(--border);">${a.invited_by ? 'Invited by ' + escapeHtmlClient(a.invited_by) + ' · ' : ''}${new Date(a.created_at).toLocaleDateString()}</p>
          ${a.can_manage_admins ? '' : `<p style="margin:4px 0 0 0; font-size:12px; color:var(--border);">${escapeHtmlClient(permissionSummaryText(a.permissions))}</p>`}
        </div>
        ${a.can_manage_admins ? '' : `
          <div style="display:flex; gap:8px;">
            <button type="button" class="btn secondary" style="padding:6px 12px; font-size:12px;" onclick="openAdminPermissionsModal('${a.email.replace(/'/g, "\\'")}')">⚙️ Permissions</button>
            <button type="button" class="btn secondary" style="padding:6px 12px; font-size:12px; color:#D32F2F; border-color:#D32F2F;" onclick="removeSuperAdminEntry('${a.email.replace(/'/g, "\\'")}')">Remove</button>
          </div>
        `}
      </div>
    `).join('') || '<p style="color:var(--border); text-align:center; padding:20px;">No admins yet.</p>';
  } catch (err) {
    console.error('Error loading admins:', err);
    const list = document.getElementById('super-admins-list');
    if (list) list.innerHTML = '<p style="color:var(--warning);">Error loading admins.</p>';
  }
}

async function handleInviteSuperAdminSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('invite-super-admin-email').value.trim();
  if (!email) {
    showToast('Please enter an email address', 'error');
    return;
  }

  const permissions = collectPermissionsFromGrid('invite-perm');

  try {
    showToast('Sending invite...', 'info');
    const result = await callEdgeFunction('invite-super-admin', { email, permissions });
    if (result.alreadyAdmin) {
      showToast(`ℹ️ ${email} is already a Super Admin. Use the ⚙️ Permissions button below to change what they can access.`, 'info');
    } else if (result.existingAccount) {
      showToast(`✅ ${email} now has Super Admin access — they already had an account, so we emailed them instead of an invite link.`, 'success');
    } else {
      showToast(`✅ Invited ${email} — they'll get an email to set their own password.`, 'success');
    }
    document.getElementById('invite-super-admin-form').reset();
    setPermissionsGrid('invite-perm', {});
    loadSuperAdminsList();
  } catch (err) {
    console.error('Invite super admin error:', err);
    showToast('Error: ' + err.message, 'error');
  }
}

async function removeSuperAdminEntry(email) {
  if (email === (currentUser ? currentUser.email : null)) {
    showToast("❌ You can't remove your own admin access from here.", 'error');
    return;
  }
  if (!confirm(`Remove Super Admin access for "${email}"? Their login account isn't deleted — this only revokes platform admin access. You can re-invite them later.`)) return;

  try {
    const { error } = await client.from('super_admins').delete().eq('email', email);
    if (error) throw error;
    showToast(`✅ Removed ${email} from Super Admins.`, 'success');
    loadSuperAdminsList();
  } catch (err) {
    console.error('Error removing admin:', err);
    showToast('❌ Error: ' + err.message, 'error');
  }
}

async function handleInviteTeammateSubmit(e) {
  e.preventDefault();
  if (!currentCompany) return;
  const email = document.getElementById('invite-teammate-email').value.trim();

  if (!email) {
    showToast('Please enter an email', 'error');
    return;
  }

  try {
    showToast('Sending invite...', 'info');
    await callInviteFunction({ companyId: currentCompany.id, email, role: 'staff' });
    showToast(`✅ Invited ${email} to your team`, 'success');
    document.getElementById('invite-teammate-form').reset();
    loadTeamMembers();
  } catch (err) {
    console.error('Invite teammate error:', err);
    showToast('Error: ' + err.message, 'error');
  }
}

async function loadTeamMembers() {
  if (!currentCompany) return;
  try {
    const { data: members, error: membersError } = await client
      .from('company_members')
      .select('id, role, email, user_id, permissions')
      .eq('company_id', currentCompany.id)
      .order('created_at', { ascending: true });

    if (membersError) throw membersError;

    teamMembersById = {};
    (members || []).forEach(m => { teamMembersById[m.id] = m; });

    const { data: invites } = await client
      .from('company_invitations')
      .select('id, email, created_at')
      .eq('company_id', currentCompany.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    let html = '';

    if (members && members.length > 0) {
      html += members.map(m => {
        const permittedCount = SUBMISSION_STAGES.filter(s => m.permissions && m.permissions[s.key] && (m.permissions[s.key].view || m.permissions[s.key].edit)).length;
        const accessSummary = m.role === 'owner'
          ? 'Full access (owner)'
          : (m.permissions === null || m.permissions === undefined)
            ? 'Full access to submissions'
            : `Limited access (${permittedCount}/${SUBMISSION_STAGES.length} stages)`;
        const showPermissionsBtn = currentMemberRole === 'owner' && m.role !== 'owner';
        return `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:10px; border:1px solid var(--border); border-radius:4px; margin-bottom:8px; flex-wrap:wrap; gap:8px;">
          <div>
            <span>${m.email || m.user_id}${currentUser && m.user_id === currentUser.id ? ' <span style="color:var(--border); font-size:12px;">(you)</span>' : ''}</span>
            <div style="font-size:12px; color:var(--border); margin-top:2px;">${accessSummary}</div>
          </div>
          <div style="display:flex; align-items:center; gap:10px;">
            <span class="submission-status approved" style="text-transform:capitalize;">${m.role}</span>
            ${showPermissionsBtn ? `<button type="button" class="btn secondary" style="padding:6px 12px; font-size:12px;" onclick="openTeamPermissionsModal('${m.id}')">⚙️ Permissions</button>` : ''}
          </div>
        </div>
      `;
      }).join('');
    } else {
      html += '<p style="color:var(--border); font-style:italic;">No team members found.</p>';
    }

    if (invites && invites.length > 0) {
      html += '<h4 style="margin-top:20px; margin-bottom:10px; font-size:12px; text-transform:uppercase; color:var(--border);">Pending Invites</h4>';
      html += invites.map(inv => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:10px; border:1px dashed var(--border); border-radius:4px; margin-bottom:8px;">
          <span>${inv.email}</span>
          <span style="font-size:12px; color:var(--border);">Invited ${new Date(inv.created_at).toLocaleDateString()}</span>
        </div>
      `).join('');
    }

    document.getElementById('team-members-list').innerHTML = html;
  } catch (err) {
    console.error('Error loading team:', err);
    const el = document.getElementById('team-members-list');
    if (el) el.innerHTML = '<p style="color:var(--warning);">Error loading team.</p>';
  }
}

let pendingTeamPermissionsMemberId = null; // which company_members row the open Permissions modal is editing

// Opens the per-stage View/Edit permissions grid for one teammate. Only the
// company owner can reach this (loadTeamMembers only renders the button for
// them) — enforced client-side here too as a second check, since the real
// enforcement is the company_members_update_owner RLS policy on save.
// Prefills every checkbox checked (full access) when the member's
// permissions column is still null — matches the "full access until
// restricted" default, so the owner sees exactly what the member currently
// has before narrowing anything.
function openTeamPermissionsModal(memberId) {
  const member = teamMembersById[memberId];
  if (!member) {
    showToast('Error: team member not found', 'error');
    return;
  }
  if (currentMemberRole !== 'owner') {
    showToast("Only the company owner can manage a teammate's permissions.", 'error');
    return;
  }

  pendingTeamPermissionsMemberId = memberId;
  document.getElementById('team-permissions-member-label').textContent = member.email || member.user_id;

  const grid = document.getElementById('team-permissions-grid');
  grid.innerHTML = SUBMISSION_STAGES.map(stage => {
    const perm = member.permissions && member.permissions[stage.key];
    // permissions IS NULL entirely -> full access -> every box starts checked
    const checkedView = member.permissions === null || member.permissions === undefined ? true : !!(perm && perm.view);
    const checkedEdit = member.permissions === null || member.permissions === undefined ? true : !!(perm && perm.edit);
    return `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid var(--border);">
        <span>${stage.label}</span>
        <div style="display:flex; gap:16px;">
          <label style="font-weight:normal; display:flex; align-items:center; gap:6px; cursor:pointer; font-size:13px;">
            <input type="checkbox" data-stage="${stage.key}" data-level="view" ${checkedView ? 'checked' : ''} onchange="syncTeamPermissionCheckbox('${stage.key}')"> View
          </label>
          <label style="font-weight:normal; display:flex; align-items:center; gap:6px; cursor:pointer; font-size:13px;">
            <input type="checkbox" data-stage="${stage.key}" data-level="edit" ${checkedEdit ? 'checked' : ''} onchange="syncTeamPermissionCheckbox('${stage.key}')"> Edit
          </label>
        </div>
      </div>
    `;
  }).join('');

  openModal('team-permissions-modal');
}

// "Edit" always implies "View" — checking Edit auto-checks View for the same
// stage, and unchecking View auto-unchecks Edit, so the two can never end up
// in an inconsistent state (same rule as the Super Admin Permissions grid).
function syncTeamPermissionCheckbox(stageKey) {
  const grid = document.getElementById('team-permissions-grid');
  const viewBox = grid.querySelector(`input[data-stage="${stageKey}"][data-level="view"]`);
  const editBox = grid.querySelector(`input[data-stage="${stageKey}"][data-level="edit"]`);
  if (!viewBox || !editBox) return;
  if (editBox.checked) viewBox.checked = true;
  if (!viewBox.checked) editBox.checked = false;
}

// Saves a fully-explicit permissions object (every stage's view/edit set
// true/false, never a partial object) — this is what turns a still-null
// (full access) member into an explicitly-restricted one going forward.
async function handleTeamPermissionsSave() {
  if (!pendingTeamPermissionsMemberId) return;
  const grid = document.getElementById('team-permissions-grid');
  const permissions = {};
  SUBMISSION_STAGES.forEach(stage => {
    const viewBox = grid.querySelector(`input[data-stage="${stage.key}"][data-level="view"]`);
    const editBox = grid.querySelector(`input[data-stage="${stage.key}"][data-level="edit"]`);
    permissions[stage.key] = { view: !!(viewBox && viewBox.checked), edit: !!(editBox && editBox.checked) };
  });

  try {
    const { error } = await client
      .from('company_members')
      .update({ permissions })
      .eq('id', pendingTeamPermissionsMemberId);
    if (error) throw error;
    showToast('✅ Permissions updated', 'success');
    closeModal('team-permissions-modal');
    pendingTeamPermissionsMemberId = null;
    loadTeamMembers();
  } catch (err) {
    console.error('Error saving team permissions:', err);
    showToast('Error: ' + err.message, 'error');
  }
}

async function loadCurrentCompanyAndRoute(wantsAdmin) {
  try {
    // Check super-admin status first — a super-admin should be able to log in
    // and reach Platform Admin even if they don't belong to any company.
    const { data: adminCheck } = await client
      .from('super_admins')
      .select('email, can_manage_admins, permissions')
      .eq('email', currentUser.email)
      .maybeSingle();
    isSuperAdmin = !!adminCheck;
    isAdminManager = !!(adminCheck && adminCheck.can_manage_admins);
    currentAdminPermissions = (adminCheck && adminCheck.permissions) || {};

    const { data: membership, error } = await client
      .from('company_members')
      .select('company_id, role, permissions, companies(*)')
      .eq('user_id', currentUser.id)
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('Error loading company membership:', error);
    }

    currentCompany = (membership && membership.companies) ? membership.companies : null;
    currentMemberRole = membership ? membership.role : null;
    currentMemberPermissions = membership ? membership.permissions : null;

    if (currentCompany && currentCompany.status === 'suspended') {
      showToast('This account has been suspended. Contact the platform admin.', 'error');
      await client.auth.signOut();
      currentCompany = null;
      applyDefaultBranding();
      showLandingView();
      return;
    }

    if (!currentCompany && !isSuperAdmin) {
      showToast('Could not find a company for this account', 'error');
      await client.auth.signOut();
      applyDefaultBranding();
      showLandingView();
      return;
    }

    if ((wantsAdmin || !currentCompany) && isSuperAdmin) {
      showSuperAdminView();
    } else {
      showAdminView();
    }
  } catch (err) {
    console.error('Error routing after login:', err);
    showToast('Error loading account: ' + err.message, 'error');
  }
}

async function logoutAdmin() {
  await client.auth.signOut();
  currentUser = null;
  currentCompany = null;
  isSuperAdmin = false;
  isAdminManager = false;
  currentAdminPermissions = {};
  window.location.href = window.location.pathname;
}

// ===== CONTRACTOR VIEW =====
async function loadContractorView(token) {
  try {
    console.log('Loading contractor view for token:', token);

    hideAllTopLevelViews();
    document.getElementById('public-view').style.display = 'block';
    hideAllPublicSections();

    const { data: invitation, error: invError } = await client
      .from('rfq_invitations')
      .select('*')
      .eq('invitation_token', token)
      .single();

    if (invError || !invitation) {
      console.error('Invitation not found');
      document.getElementById('no-rfq-message').style.display = 'block';
      document.getElementById('rfq-portal').style.display = 'none';
      document.getElementById('no-rfq-message').innerHTML = '<div class="card"><h2>Invalid Link</h2><p>This RFQ link is invalid or has expired.</p></div>';
      return;
    }

    currentRFQId = invitation.rfq_id;
    console.log('✅ Invitation found for RFQ:', currentRFQId);

    await loadRFQDetails(currentRFQId);
    document.getElementById('rfq-portal').style.display = 'block';
    document.getElementById('no-rfq-message').style.display = 'none';

  } catch (err) {
    console.error('Error loading contractor view:', err);
  }
}

// Public "respond to an information request" page, reached via the emailed
// ?info=TOKEN link. Uses the get_submission_by_info_token/submit_additional_info
// RPCs (SECURITY DEFINER) since the contractor isn't logged in and RLS
// otherwise blocks reading/updating someone else's submission — the token
// itself is the credential, same trust model as the existing rfq_invitations
// invite-link tokens.
let currentInfoRequestToken = null;
let currentInfoRequestSubmissionId = null;
let currentInfoRequestRfqId = null;

// Public "update my notification preferences" page, reached via the
// ?prefs=TOKEN link included in every new-RFQ notification email. Uses
// get_applicant_preferences/update_applicant_province (SECURITY DEFINER)
// since the supplier isn't logged in — the token is the credential, same
// trust model as the info-request/invite-link tokens above.
let currentPrefsToken = null;

// The same preferences page also lets a supplier upload/replace any of
// their own Supplier Database documents (all 8 categories, not just the
// 3 mandatory ones) without logging in — see renderPrefsDocumentsList()
// and uploadOrReplacePrefsDocument() below. currentPrefsApplicantId comes
// back from get_my_documents() (get_applicant_preferences() doesn't
// return it) and is needed to build the same applicant-<id>/... storage
// path used at original registration time.
let currentPrefsApplicantId = null;
let currentPrefsDocuments = null; // full get_my_documents() row for the current token
let pendingPrefsDocUpload = null; // { category, keyPrefix, label }

async function loadInfoRequestView(token) {
  try {
    hideAllTopLevelViews();
    document.getElementById('public-view').style.display = 'block';
    hideAllPublicSections();

    const { data, error } = await client.rpc('get_submission_by_info_token', { p_token: token });
    const row = Array.isArray(data) ? data[0] : data;

    if (error || !row) {
      console.error('Info request link not found:', error);
      document.getElementById('no-rfq-message').style.display = 'block';
      document.getElementById('rfq-portal').style.display = 'none';
      document.getElementById('no-rfq-message').innerHTML = '<div class="card"><h2>Invalid Link</h2><p>This link is invalid or has already been used.</p></div>';
      return;
    }

    currentInfoRequestToken = token;
    currentInfoRequestSubmissionId = row.submission_id;
    currentInfoRequestRfqId = row.rfq_id;

    if (row.company_id) {
      const { data: company } = await client
        .from('companies')
        .select('*')
        .eq('id', row.company_id)
        .maybeSingle();
      if (company) {
        applyCompanyBranding(company, {
          subtitle: 'Request for Quotation Portal',
          heroTitle: company.name,
          heroSubtitle: `${company.name} has asked for more information on your submission.`
        });
      } else {
        applyDefaultBranding();
      }
    } else {
      applyDefaultBranding();
    }

    const alreadyResponded = !!row.info_response_message;

    const formHtml = `
      <div class="card">
        <h2 style="margin-top:0;">Additional Information Requested</h2>
        <p style="color: var(--border); margin-bottom: 20px;">For your submission to: <strong>${row.rfq_name}</strong> (${row.project_name})</p>

        <div style="background: var(--bg-2); padding: 15px; border-radius: 4px; margin-bottom: 20px;">
          <p style="margin:0 0 6px 0; font-size:12px; text-transform:uppercase; color:var(--border); font-weight:bold;">They've asked for:</p>
          <p style="margin:0; white-space:pre-wrap;">${row.info_request_message || ''}</p>
        </div>

        ${alreadyResponded ? `
          <div style="background:#E1F0FF; padding:15px; border-radius:4px; margin-bottom:20px;">
            <p style="margin:0 0 6px 0; font-size:12px; text-transform:uppercase; color:var(--border); font-weight:bold;">Your previous response:</p>
            <p style="margin:0; white-space:pre-wrap;">${row.info_response_message}</p>
          </div>
        ` : ''}

        <form id="info-request-form" style="margin-top: 10px;">
          <div style="margin-bottom: 15px;">
            <label>Your Response *</label>
            <textarea id="info-response-message" required rows="4" style="width:100%; padding:10px; border:1px solid var(--border); border-radius:4px; font-family:inherit;" placeholder="Provide the requested information here..."></textarea>
          </div>

          <div style="margin-bottom: 15px;">
            <label>Upload Supporting Document(s)</label>
            <input type="file" id="info-response-files" multiple>
          </div>

          <button type="submit" class="btn gold" style="width: 100%; padding: 15px; margin-top: 10px;">Submit Response</button>
        </form>
      </div>
    `;

    document.getElementById('rfq-portal').innerHTML = formHtml;
    document.getElementById('rfq-portal').style.display = 'block';
    document.getElementById('no-rfq-message').style.display = 'none';

    document.getElementById('info-request-form').addEventListener('submit', (e) => {
      e.preventDefault();
      submitAdditionalInfoForm();
    });

  } catch (err) {
    console.error('Error loading info request view:', err);
    showToast('Error loading page', 'error');
  }
}

async function submitAdditionalInfoForm() {
  try {
    const message = document.getElementById('info-response-message').value.trim();
    if (!message) {
      showToast('Please enter a response', 'error');
      return;
    }

    showToast('Submitting...', 'success');

    const { data: submissionId, error } = await client.rpc('submit_additional_info', {
      p_token: currentInfoRequestToken,
      p_message: message
    });

    if (error) throw error;

    const resolvedSubmissionId = submissionId || currentInfoRequestSubmissionId;

    const fileInput = document.getElementById('info-response-files');
    let filesUploaded = 0;
    if (fileInput && fileInput.files && fileInput.files.length > 0) {
      for (const file of fileInput.files) {
        try {
          const filePath = `rfq-${currentInfoRequestRfqId}/sub-${resolvedSubmissionId}/${Date.now()}-${sanitizeStorageFileName(file.name)}`;
          const { error: uploadError } = await client.storage
            .from('rfq-documents')
            .upload(filePath, file);

          if (uploadError) {
            console.warn('⚠️ File upload failed:', uploadError.message);
            continue;
          }

          await client.from('rfq_submission_documents').insert([{
            submission_id: resolvedSubmissionId,
            file_name: file.name,
            file_path: filePath,
            file_size: file.size
          }]);

          filesUploaded++;
        } catch (fileErr) {
          console.warn('⚠️ Error uploading file:', fileErr.message);
        }
      }
    }

    showToast('✅ Response submitted!', 'success');
    setTimeout(() => {
      document.getElementById('rfq-portal').innerHTML = '<div class="card"><h2 style="margin-top:0; color:var(--success);">Thank You!</h2><p>Your response has been received.</p></div>';
    }, 1000);

  } catch (err) {
    console.error('Error submitting response:', err);
    showToast('Error: ' + err.message, 'error');
  }
}

const PROVINCE_OPTIONS = [
  'Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'Limpopo',
  'Mpumalanga', 'Northern Cape', 'North West', 'Western Cape'
];

// The 7 single-value Supplier Database document categories a registered
// supplier can upload/replace from their own no-login preferences page
// (?prefs=TOKEN). "Other Documents" (an unbounded list, not a single
// value) is handled separately in renderPrefsDocumentsList() below.
// `category` matches update_applicant_document()'s category argument;
// `keyPrefix` matches the prefix uploadSupplierDocument() already uses
// at original registration time, so get_my_documents()'s filename
// stripping recognizes a freshly-replaced file the same way.
const SUPPLIER_DOC_CATEGORIES = [
  { category: 'cipc', keyPrefix: 'cipc', label: 'CIPC Registration / ID', mandatory: true },
  { category: 'proof_of_address', keyPrefix: 'proof-of-address', label: 'Proof of Address', mandatory: true },
  { category: 'sars', keyPrefix: 'sars', label: 'SARS Information', mandatory: true },
  { category: 'proof_of_banking', keyPrefix: 'banking', label: 'Proof of Banking', mandatory: false },
  { category: 'bbbee', keyPrefix: 'bbbee', label: 'B-BBEE Affidavit/Certificate', mandatory: false },
  { category: 'health_safety', keyPrefix: 'health-safety', label: 'Health & Safety Certificate', mandatory: false },
  { category: 'special_permits', keyPrefix: 'permits', label: 'Special Permits/Registrations', mandatory: false }
];

// Renders the "Your Documents" card body on the preferences page from
// currentPrefsDocuments (a get_my_documents() row). Kept as its own
// function so a single upload/replace can refresh just this section in
// place afterward, without re-rendering the whole page.
function renderPrefsDocumentsList() {
  if (!currentPrefsDocuments) {
    return '<p style="color:var(--border); font-size:13px;">Could not load your documents right now — you can still update your province above, or try reloading this page.</p>';
  }
  const docs = currentPrefsDocuments;

  const rows = SUPPLIER_DOC_CATEGORIES.map(({ category, keyPrefix, label, mandatory }) => {
    const has = !!docs['has_' + category];
    const fileName = docs[category + '_file_name'];
    return `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid var(--bg-2);">
        <div>
          <p style="margin:0; font-size:14px;">${escapeHtmlClient(label)}${mandatory ? ' <span style="color:var(--accent); font-size:12px;">(required)</span>' : ''}</p>
          <p style="margin:2px 0 0 0; font-size:12px; color:var(--border);">${has ? '📄 ' + escapeHtmlClient(fileName || 'On file') : 'Not uploaded yet'}</p>
        </div>
        <button type="button" class="btn secondary" style="padding:6px 12px; font-size:12px; white-space:nowrap;" onclick="uploadOrReplacePrefsDocument('${category}', '${keyPrefix}', '${label.replace(/'/g, "\\'")}')">${has ? '🔄 Replace' : '⬆️ Upload'}</button>
      </div>
    `;
  }).join('');

  const otherDocs = docs.other_documents || [];
  const otherRows = otherDocs.length > 0
    ? otherDocs.map(d => `<div style="padding:6px 0; font-size:13px; color:var(--ink);">📄 ${escapeHtmlClient(d.name || 'Document')}</div>`).join('')
    : '<p style="margin:0 0 6px 0; font-size:12px; color:var(--border);">None on file yet.</p>';

  return `
    ${rows}
    <div style="margin-top:15px;">
      <p style="margin:0 0 6px 0; font-size:14px;">Other Documents</p>
      ${otherRows}
      <button type="button" class="btn secondary" style="padding:6px 12px; font-size:12px;" onclick="uploadOrReplacePrefsDocument('other', 'other', 'Other Document')">➕ Add a Document</button>
    </div>
  `;
}

// Opens the shared hidden file input for a given document category; the
// actual upload happens in handlePrefsDocFileSelected() once a file is
// chosen. Mirrors uploadOrReplaceSupplierDocument()'s admin-side pattern.
function uploadOrReplacePrefsDocument(category, keyPrefix, label) {
  pendingPrefsDocUpload = { category, keyPrefix, label };
  const input = document.getElementById('prefs-doc-upload-input');
  if (!input) return;
  input.value = '';
  input.click();
}

async function handlePrefsDocFileSelected(e) {
  const file = e.target.files[0];
  const pending = pendingPrefsDocUpload;
  pendingPrefsDocUpload = null;
  if (!file || !pending || !currentPrefsToken || !currentPrefsApplicantId) return;

  try {
    // Same applicant-<id>/... path convention uploadSupplierDocument()
    // uses at original registration time — the bucket allows anonymous
    // insert (no login), same trust model as the rest of this page.
    const filePath = `applicant-${currentPrefsApplicantId}/${pending.keyPrefix}-${Date.now()}-${sanitizeStorageFileName(file.name)}`;
    const { error: uploadError } = await client.storage.from('supplier-documents').upload(filePath, file);
    if (uploadError) throw uploadError;

    const { error: rpcError } = await client.rpc('update_applicant_document', {
      p_token: currentPrefsToken,
      p_category: pending.category,
      p_file_path: filePath,
      p_file_name: file.name
    });
    if (rpcError) throw rpcError;

    showToast(`✅ ${pending.label} updated.`, 'success');

    // Refresh just the documents section in place, not the whole page —
    // avoids interrupting the province form if the applicant is mid-way
    // through changing that too.
    const { data } = await client.rpc('get_my_documents', { p_token: currentPrefsToken });
    currentPrefsDocuments = (data && data[0]) || currentPrefsDocuments;
    const listEl = document.getElementById('prefs-documents-list');
    if (listEl) listEl.innerHTML = renderPrefsDocumentsList();
  } catch (err) {
    console.error('Error updating document:', err);
    showToast('❌ Error updating document: ' + err.message, 'error');
  }
}

async function loadSupplierPreferencesView(token) {
  try {
    hideAllTopLevelViews();
    document.getElementById('public-view').style.display = 'block';
    hideAllPublicSections();

    const { data, error } = await client.rpc('get_applicant_preferences', { p_token: token });
    const row = Array.isArray(data) ? data[0] : data;

    if (error || !row) {
      console.error('Preferences link not found:', error);
      document.getElementById('no-rfq-message').style.display = 'block';
      document.getElementById('rfq-portal').style.display = 'none';
      document.getElementById('no-rfq-message').innerHTML = '<div class="card"><h2>Invalid Link</h2><p>This link is invalid. Please use the link from your most recent RFQ Hub email.</p></div>';
      return;
    }

    currentPrefsToken = token;

    // Best-effort — a failure here just means the Documents card shows a
    // fallback message; it never blocks the province form above it.
    currentPrefsApplicantId = null;
    currentPrefsDocuments = null;
    try {
      const { data: docRows } = await client.rpc('get_my_documents', { p_token: token });
      currentPrefsDocuments = (docRows && docRows[0]) || null;
      currentPrefsApplicantId = currentPrefsDocuments ? currentPrefsDocuments.id : null;
    } catch (docsErr) {
      console.warn('Could not load documents:', docsErr.message);
    }

    const optionsHtml = [
      `<option value="ALL"${row.province === 'ALL' ? ' selected' : ''}>All Provinces</option>`,
      ...PROVINCE_OPTIONS.map(p => `<option value="${p}"${row.province === p ? ' selected' : ''}>${p}</option>`)
    ].join('');

    const formHtml = `
      <div class="card" style="max-width:480px; margin:0 auto;">
        <h2 style="margin-top:0;">Notification Preferences</h2>
        <p style="color: var(--border); margin-bottom: 20px;">${escapeHtmlClient(row.full_name)} (${escapeHtmlClient(row.email)})</p>

        <form id="prefs-form">
          <div style="margin-bottom: 15px;">
            <label>Notify Me About New Opportunities In</label>
            <select id="prefs-province" required style="width:100%; box-sizing:border-box; padding:10px; border:1px solid var(--border); border-radius:4px; font-family:inherit;">
              ${row.province ? '' : '<option value="" selected disabled>Select a province...</option>'}
              ${optionsHtml}
            </select>
            <p style="margin:6px 0 0 0; font-size:12px; color:var(--border);">Currently: ${row.province ? (row.province === 'ALL' ? 'All Provinces' : escapeHtmlClient(row.province)) : 'not set — you will not receive any RFQ notifications until you choose one.'}</p>
          </div>
          <button type="submit" class="btn gold" style="width: 100%; padding: 12px;">Save Preferences</button>
        </form>
      </div>

      <div class="card" style="max-width:480px; margin:20px auto 0 auto;">
        <h2 style="margin-top:0;">Your Documents</h2>
        <p style="color: var(--border); margin-bottom: 5px; font-size:13px;">If any of your documents are out of date, upload a new copy below — it replaces what's currently on file.</p>
        <div id="prefs-documents-list">${renderPrefsDocumentsList()}</div>
      </div>
    `;

    document.getElementById('rfq-portal').innerHTML = formHtml;
    document.getElementById('rfq-portal').style.display = 'block';
    document.getElementById('no-rfq-message').style.display = 'none';

    document.getElementById('prefs-form').addEventListener('submit', (e) => {
      e.preventDefault();
      submitSupplierPreferencesForm();
    });

  } catch (err) {
    console.error('Error loading preferences view:', err);
    showToast('Error loading page', 'error');
  }
}

async function submitSupplierPreferencesForm() {
  try {
    const province = document.getElementById('prefs-province').value;
    if (!province) {
      showToast('Please select a province', 'error');
      return;
    }

    const { error } = await client.rpc('update_applicant_province', {
      p_token: currentPrefsToken,
      p_province: province
    });

    if (error) throw error;

    showToast('✅ Preferences saved', 'success');
  } catch (err) {
    console.error('Error saving preferences:', err);
    showToast('Error: ' + err.message, 'error');
  }
}

// Small standalone HTML-escaper for the preferences page (mirrors the
// inline escaping style used elsewhere in this file for user-supplied text).
function escapeHtmlClient(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadOpenRFQView(rfqId) {
  try {
    console.log('Loading open RFQ view:', rfqId);

    hideAllTopLevelViews();
    document.getElementById('public-view').style.display = 'block';
    hideAllPublicSections();

    currentRFQId = rfqId;
    await loadRFQDetails(rfqId, true);
    document.getElementById('rfq-portal').style.display = 'block';
    document.getElementById('no-rfq-message').style.display = 'none';

  } catch (err) {
    console.error('Error loading open RFQ view:', err);
  }
}

async function loadRFQDetails(rfqId, isOpenAccess = false) {
  try {
    const { data: rfq, error } = await client
      .from('rfqs')
      .select('*')
      .eq('id', rfqId)
      .single();

    if (error || !rfq) {
      throw new Error('RFQ not found');
    }

    currentRFQData = rfq;

    // Direct public-portal access must be to an RFQ the company actually
    // marked "Open" — a closed RFQ is only reachable via its invite link,
    // even if someone guesses/shares its id. An unpublished (withdrawn) RFQ
    // is blocked the same way, even though it was originally Open — the
    // real enforcement is the rfqs_select_scoped RLS policy (a withdrawn
    // RFQ simply won't come back for an anonymous visitor at all), this is
    // just the friendlier message for the rare case a company member views
    // their own withdrawn RFQ via this same code path.
    if (isOpenAccess && (!rfq.is_public || rfq.is_withdrawn)) {
      document.getElementById('rfq-portal').innerHTML = rfq.is_withdrawn
        ? '<div class="card"><h2 style="margin-top:0;">Not Available</h2><p>This opportunity has been unpublished by the issuing company and is no longer available.</p></div>'
        : '<div class="card"><h2 style="margin-top:0;">Not Available</h2><p>This RFQ is invite-only and can\'t be accessed from the public portal.</p></div>';
      document.getElementById('rfq-portal').style.display = 'block';
      applyDefaultBranding();
      return;
    }

    console.log('RFQ loaded:', rfq.rfq_name);

    let company = null;
    if (rfq.company_id) {
      const { data: companyData } = await client
        .from('companies')
        .select('*')
        .eq('id', rfq.company_id)
        .maybeSingle();
      company = companyData || null;
    }

    if (company) {
      currentRFQCompanyName = company.name;
      applyCompanyBranding(company, {
        subtitle: 'Request for Quotation Portal',
        heroTitle: company.name,
        heroSubtitle: isOpenAccess
          ? `${company.name} is accepting quotations for this RFQ.`
          : `You've been invited to submit a quotation to ${company.name}.`
      });
    } else {
      currentRFQCompanyName = null;
      applyDefaultBranding();
    }

    // Suspended/removed suppliers can still view this RFQ (per Brent's
    // explicit instruction) but can't apply — this only drives the UI
    // (banner + disabled button); the real enforcement is the DB-level
    // rfq_submissions insert policy, which blocks it regardless of this.
    const isApplicationBlocked = !!(currentApplicantStatus && (currentApplicantStatus.status === 'suspended' || currentApplicantStatus.status === 'removed'));

    // Build contractor form
    let formHtml = `
      <div class="card">
        <h2 style="margin-top:0;">${rfq.rfq_name}</h2>
        <p style="color: var(--border); margin-bottom: 20px;">${rfq.description}</p>

        ${(rfq.location_area || (rfq.provinces && rfq.provinces.length > 0)) ? `<p><strong>Location:</strong> ${[rfq.location_area, ...(rfq.provinces || [])].filter(Boolean).join(', ')}</p>` : ''}
        ${rfq.budget ? `<p><strong>Budget:</strong> R${rfq.budget.toLocaleString()}</p>` : ''}
        ${rfq.deadline ? `<p><strong>Deadline:</strong> ${new Date(rfq.deadline).toLocaleDateString()}</p>` : ''}

        ${rfq.is_local_preference ? `<p style="color:var(--success); font-weight:500;">✓ <strong>Local Preference</strong> — This RFQ prioritizes local labour and contractors.</p>` : `<p style="color:var(--border); font-weight:500;">🌐 <strong>Non-Local</strong> — This RFQ is open to suppliers from other areas.</p>`}

        ${rfq.required_documents && rfq.required_documents.length > 0 ? `
          <div style="margin: 20px 0;">
            <h4>Required Documents:</h4>
            <ul>
              ${rfq.required_documents.map(doc => `<li>${escapeHtmlClient(doc.name)}${doc.mandatory ? ' <strong style="color:var(--accent);">(Mandatory)</strong>' : ''}${doc.requires_expiry ? ' <span style="color:var(--border); font-size:12px;">— expiry date required</span>' : ''}</li>`).join('')}
            </ul>
          </div>
        ` : ''}

        ${rfq.attachments && rfq.attachments.length > 0 ? `
          <div style="margin: 20px 0; padding: 15px; background: var(--bg-2); border-radius: 4px;">
            <h4 style="margin-top:0;">RFQ Documents</h4>
            <p style="color: var(--border); font-size: 14px; margin-bottom: 10px;">Please review before applying:</p>
            <ul style="margin:0; padding-left:20px;">
              ${rfq.attachments.map(att => `<li style="margin-bottom:6px;"><a href="${att.url}" target="_blank" rel="noopener noreferrer">${att.name}</a></li>`).join('')}
            </ul>
          </div>
        ` : ''}

        <div style="margin: 20px 0; padding: 15px; background: var(--bg-2); border-radius: 4px;">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
            <h4 style="margin:0;">Questions &amp; Answers</h4>
            ${isInGracePeriod(rfq.deadline) ? `
              <span style="font-size:12px; color:var(--warning); font-weight:500; padding:6px 12px; background:rgba(255,193,7,0.1); border-radius:4px;">🔒 Closed - Questions Only</span>
            ` : ''}
            <button type="button" class="btn secondary" style="padding:8px 14px;" ${isGracePeriodExpired(rfq.deadline) ? 'disabled' : ''} onclick="openAskQuestionModal('${rfq.id}', '${escapeHtmlClient(rfq.rfq_name).replace(/'/g, "\\'")}')">❓ Ask for more information</button>
          </div>
          ${isGracePeriodExpired(rfq.deadline) ? `
            <p style="color:var(--border); font-size:12px; margin:12px 0 0 0; font-style:italic;">This RFQ closed more than 3 days ago. Questions are no longer accepted, but you can view published clarifications below.</p>
          ` : isInGracePeriod(rfq.deadline) ? `
            <p style="color:var(--border); font-size:12px; margin:12px 0 0 0; font-style:italic;">This RFQ has closed, but you can still ask questions for the next 3 days in case you missed including supporting documents.</p>
          ` : ''}
          <div id="rfq-qa-list" style="margin-top:12px;"><p style="color: var(--border); font-size: 13px; margin:0;">Loading...</p></div>
        </div>

        ${currentApplicantStatus && (currentApplicantStatus.status === 'suspended' || currentApplicantStatus.status === 'removed') ? `
          <div style="margin: 20px 0; padding: 15px; background:#FDECEA; border:1px solid #D32F2F; border-radius:4px;">
            <p style="margin:0; font-weight:600; color:#D32F2F;">⚠️ Your supplier registration has been ${currentApplicantStatus.status === 'suspended' ? 'suspended' : 'removed'}.</p>
            <p style="margin:6px 0 0 0; font-size:13px; color:var(--ink);">You can still view this RFQ, but you can't submit an application. ${currentApplicantStatus.status_reason ? 'Reason: ' + escapeHtmlClient(currentApplicantStatus.status_reason) + '.' : ''} Please contact us if you believe this is a mistake.</p>
          </div>
        ` : ''}

        <form id="contractor-form" style="margin-top: 30px;">
          <h3>Your Company Information</h3>

          <div style="margin-bottom: 15px;">
            <label>Company Name *</label>
            <input type="text" id="contractor-name" required style="width:100%;">
          </div>

          <div style="margin-bottom: 15px;">
            <label>Email Address *</label>
            <input type="email" id="contractor-email" required style="width:100%;">
          </div>

          <div style="margin-bottom: 15px;">
            <label>Phone Number</label>
            <input type="tel" id="contractor-phone" style="width:100%;">
          </div>

          <div style="margin-bottom: 15px;">
            <label>Company Registration Number</label>
            <input type="text" id="contractor-reg" style="width:100%;">
          </div>

          <div style="margin-top: 30px;">
            <h4>Upload Documents</h4>
            <p style="color: var(--border); font-size: 14px;">Documents marked * are mandatory and must be uploaded to submit. Any file type is accepted — a clear phone photo of the document is fine.</p>
            ${rfq.required_documents.map((doc, idx) => {
              const reuseAvailable = !!(doc.supplier_doc_category && !doc.requires_expiry &&
                currentApplicantDocuments && currentApplicantDocuments['has_' + doc.supplier_doc_category]);
              const wasRequired = !!doc.mandatory;
              // When a reuse offer is on the table, default to "reuse" and keep
              // the underlying file input hidden + not required — toggleDocReuse
              // flips both if the applicant picks "upload a new one" instead.
              // data-was-required remembers the original required-ness so it can
              // be restored; a hidden `required` file input misbehaves in some
              // browsers' native validation, so it's only ever added while shown.
              const fileInputHtml = `<input type="file" id="doc-${idx}" data-doc-name="${escapeHtmlClient(doc.name)}" data-was-required="${wasRequired}"${reuseAvailable ? ' data-supplier-category="' + doc.supplier_doc_category + '" style="display:none;"' : (wasRequired ? ' required' : '')}>`;
              const onFileName = reuseAvailable ? currentApplicantDocuments[doc.supplier_doc_category + '_file_name'] : '';
              return `
              <div style="margin-bottom: 15px;">
                <label>${escapeHtmlClient(doc.name)}${doc.mandatory ? ' *' : ''}</label>
                ${reuseAvailable ? `
                  <div style="margin:6px 0 10px 0; padding:10px; background:var(--bg-2); border-radius:4px;">
                    <p style="margin:0 0 6px 0; font-size:13px; color:var(--ink);">You already have a document on file for this: <strong>${escapeHtmlClient(onFileName || '')}</strong></p>
                    <label style="display:block; font-size:13px; font-weight:normal; margin-bottom:4px;">
                      <input type="radio" name="doc-reuse-${idx}" value="reuse" checked onchange="toggleDocReuse(${idx})"> Use the document on file
                    </label>
                    <label style="display:block; font-size:13px; font-weight:normal;">
                      <input type="radio" name="doc-reuse-${idx}" value="new" onchange="toggleDocReuse(${idx})"> Upload a different one
                    </label>
                  </div>
                ` : ''}
                ${fileInputHtml}
                ${doc.requires_expiry ? `
                  <div style="margin-top:6px;">
                    <label style="font-size:13px; font-weight:normal;">Expiry Date for ${escapeHtmlClient(doc.name)} *</label>
                    <input type="date" id="doc-expiry-${idx}" required style="padding:8px; border:1px solid var(--border); border-radius:4px;">
                  </div>
                ` : ''}
              </div>
            `;
            }).join('')}
          </div>

          <div style="margin-top: 30px; padding: 20px; background: var(--bg-2); border-radius: 4px;">
            <h4 style="margin-top:0;">Your Quotation</h4>
            <p style="color: var(--border); font-size: 14px; margin-bottom: 15px;">Upload your quotation below. This is what the RFQ issuer reviews alongside your application — attach more than one file if your quote runs to several documents.</p>
            <div style="margin-bottom: 15px;">
              <label>Quotation Document(s) *</label>
              <input type="file" id="contractor-quote-docs" multiple required style="width:100%;">
              <p style="color: var(--border); font-size: 12px; margin:6px 0 0 0;">Any file type is accepted, including a photo of a printed quote.</p>
            </div>
          </div>

          <div style="margin-top: 30px;">
            <h4>Additional Optional Documents</h4>
            <p style="color: var(--border); font-size: 14px;">Upload any supplementary documents (e.g., technical specifications, references, case studies, certifications). You can select multiple files at once.</p>
            <div style="margin-bottom: 15px;">
              <label>Additional Documents</label>
              <input type="file" id="contractor-optional-docs" multiple style="width:100%;">
              <p style="color: var(--border); font-size: 12px; margin:6px 0 0 0;">Any file type is accepted, including photos.</p>
            </div>
          </div>

          <button type="submit" class="btn gold" id="contractor-submit-btn" style="width: 100%; padding: 15px; margin-top: 20px;"${isApplicationBlocked ? ' disabled' : ''}>${isApplicationBlocked ? 'Application Unavailable' : 'Submit Application'}</button>
        </form>
      </div>
    `;

    document.getElementById('rfq-portal').innerHTML = formHtml;

    document.getElementById('contractor-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (isApplicationBlocked) {
        showToast('❌ Your supplier registration doesn\'t allow applying to RFQs right now.', 'error');
        return;
      }
      const token = new URLSearchParams(window.location.search).get('rfq');

      // Show application privacy popup if not already accepted
      if (!applicationPrivacyAccepted) {
        window.pendingSubmitToken = token;
        window.pendingRfqCompanyName = rfq.company_name;
        document.getElementById('privacy-rfq-company-name').textContent = rfq.company_name;
        openModal('application-privacy-modal');
        return;
      }

      submitContractorForm(token);
    });

    loadPublicQA(rfq.id);

  } catch (err) {
    console.error('Error loading RFQ details:', err);
    showToast('Error loading RFQ', 'error');
  }
}

// Renders only questions the owning company chose to answer publicly —
// get_public_rfq_questions() is a SECURITY DEFINER RPC that deliberately
// excludes applicant_email/applicant_name so the asker stays anonymous to
// other contractors viewing this page.
async function loadPublicQA(rfqId) {
  const listEl = document.getElementById('rfq-qa-list');
  if (!listEl) return;

  try {
    const { data: qa, error } = await client.rpc('get_public_rfq_questions', { p_rfq_id: rfqId });
    if (error) throw error;

    if (!qa || qa.length === 0) {
      listEl.innerHTML = '<p style="color: var(--border); font-size: 13px; margin:0;">No published questions yet. Be the first to ask.</p>';
      return;
    }

    listEl.innerHTML = qa.map(item => `
      <div style="background:white; border:1px solid var(--border); border-radius:4px; padding:12px; margin-bottom:10px;">
        <p style="margin:0 0 6px 0; font-weight:bold; color:var(--ink);">Q: ${escapeHtmlClient(item.question)}</p>
        <p style="margin:0; color:var(--ink); white-space:pre-wrap;">A: ${escapeHtmlClient(item.answer)}</p>
      </div>
    `).join('');
  } catch (err) {
    console.error('Error loading public Q&A:', err);
    listEl.innerHTML = '<p style="color: var(--border); font-size: 13px; margin:0;">Could not load questions right now.</p>';
  }
}

// Flips a required document's file input between "hidden, reusing the
// on-file copy" and "visible, upload a new one" as the applicant switches
// the doc-reuse-${idx} radio choice. The `required` attribute is added or
// removed here rather than just toggled via CSS, since a hidden `required`
// file input trips up native constraint validation in some browsers —
// data-was-required (recorded at render time) is what it's restored from.
function toggleDocReuse(idx) {
  const fileInput = document.getElementById(`doc-${idx}`);
  if (!fileInput) return;
  const selected = document.querySelector(`input[name="doc-reuse-${idx}"]:checked`);
  const useNew = !!(selected && selected.value === 'new');
  if (useNew) {
    fileInput.style.display = '';
    if (fileInput.dataset.wasRequired === 'true') fileInput.setAttribute('required', 'required');
  } else {
    fileInput.style.display = 'none';
    fileInput.value = '';
    fileInput.removeAttribute('required');
  }
}

async function submitContractorForm(token) {
  try {
    const name = document.getElementById('contractor-name').value.trim();
    const email = document.getElementById('contractor-email').value.trim();
    const phone = document.getElementById('contractor-phone').value.trim();
    const reg = document.getElementById('contractor-reg').value.trim();
    const quoteInput = document.getElementById('contractor-quote-docs');
    const quoteFiles = quoteInput && quoteInput.files ? Array.from(quoteInput.files) : [];

    if (!name || !email) {
      showToast('Please fill in required fields', 'error');
      return;
    }

    if (quoteFiles.length === 0) {
      showToast('Please attach your quotation before submitting', 'error');
      return;
    }

    // Collect any "use the document on file" choices before touching the
    // database — reused documents are copied via the reuse-supplier-documents
    // Edge Function (the Supplier Database's own document bucket is private,
    // so a contractor's browser can't read it directly; the function is the
    // one privileged step that can, and hands back a copy the client is
    // allowed to reference). A mandatory document that fails to copy must
    // abort the whole submission rather than silently going missing.
    const reuseSelections = []; // [{ idx, category, documentName, mandatory }]
    (currentRFQData.required_documents || []).forEach((doc, idx) => {
      const radios = document.getElementsByName(`doc-reuse-${idx}`);
      if (!radios || radios.length === 0) return;
      const checked = Array.from(radios).find(r => r.checked);
      if (checked && checked.value === 'reuse' && doc.supplier_doc_category) {
        reuseSelections.push({
          idx,
          category: doc.supplier_doc_category,
          documentName: doc.name,
          mandatory: !!doc.mandatory
        });
      }
    });

    let reuseResults = {}; // category -> { success, filePath, fileName, fileSize, error? }
    if (reuseSelections.length > 0) {
      showToast('Preparing documents on file...', 'success');
      try {
        const reuseResponse = await callPublicEdgeFunction('reuse-supplier-documents', {
          email: currentApplicantEmail || email,
          rfqId: currentRFQId,
          categories: reuseSelections.map(sel => sel.category)
        });
        reuseResults = reuseResponse.results || {};
      } catch (reuseErr) {
        console.error('Error reusing documents on file:', reuseErr);
        showToast('❌ Could not prepare your documents on file: ' + reuseErr.message, 'error');
        return;
      }

      const failedMandatory = reuseSelections.find(sel => sel.mandatory && !(reuseResults[sel.category] && reuseResults[sel.category].success));
      if (failedMandatory) {
        const reason = (reuseResults[failedMandatory.category] && reuseResults[failedMandatory.category].error) || 'Unknown error';
        showToast(`❌ Couldn't use your document on file for "${failedMandatory.documentName}" (${reason}). Please choose "Upload a different one" for that document and try again.`, 'error');
        return;
      }
    }

    showToast('Submitting...', 'success');

    // Generate the submission id client-side so we don't need to read the row
    // back after insert (contractors are unauthenticated, and submissions are
    // only readable by the owning company under RLS).
    const submissionId = generateUUID();

    const { error: subError } = await client
      .from('rfq_submissions')
      .insert([{
        id: submissionId,
        rfq_id: currentRFQId,
        contractor_name: name,
        contractor_email: email,
        contractor_phone: phone,
        contractor_reg: reg,
        status: 'submitted'
      }]);

    if (subError) throw subError;

    console.log('✅ Submission created:', submissionId);

    // Upload files. Non-mandatory documents are optional, so a failed/missing
    // upload here doesn't abort the whole submission — mandatory documents
    // and required expiry dates are already enforced by the form's own
    // `required` attributes before this handler ever runs (native HTML5
    // validation blocks the submit event otherwise).
    const fileInputs = document.querySelectorAll('input[type="file"][id^="doc-"]');
    let filesUploaded = 0;

    for (let input of fileInputs) {
      if (input.files[0]) {
        try {
          const file = input.files[0];
          const filePath = `rfq-${currentRFQId}/sub-${submissionId}/${Date.now()}-${sanitizeStorageFileName(file.name)}`;

          const { error: uploadError } = await client.storage
            .from('rfq-documents')
            .upload(filePath, file);

          if (uploadError) {
            console.warn('⚠️ File upload failed:', uploadError.message);
            continue;
          }

          // Pair this upload back to its required-document entry (name +
          // whether an expiry date was collected for it) using the same
          // index the form was rendered with.
          const idx = input.id.replace('doc-', '');
          const docMeta = (currentRFQData && currentRFQData.required_documents && currentRFQData.required_documents[idx]) || null;
          const expiryInput = docMeta && docMeta.requires_expiry ? document.getElementById(`doc-expiry-${idx}`) : null;

          await client.from('rfq_submission_documents').insert([{
            submission_id: submissionId,
            file_name: file.name,
            file_path: filePath,
            file_size: file.size,
            document_type: docMeta ? docMeta.name : null,
            expiry_date: (expiryInput && expiryInput.value) ? expiryInput.value : null
          }]);

          filesUploaded++;
        } catch (fileErr) {
          console.warn('⚠️ Error uploading file:', fileErr.message);
        }
      }
    }

    // Upload the supplier's quotation document(s). These are the priced
    // response the RFQ issuer reviews, so they're flagged with their own
    // document_type and the form makes at least one file mandatory.
    let quotesUploaded = 0;

    for (let file of quoteFiles) {
      try {
        const timestamp = Date.now() + Math.random(); // Ensure unique names for multiple files
        const filePath = `rfq-${currentRFQId}/sub-${submissionId}/${timestamp}-${sanitizeStorageFileName(file.name)}`;

        const { error: uploadError } = await client.storage
          .from('rfq-documents')
          .upload(filePath, file);

        if (uploadError) {
          console.warn('⚠️ Quotation upload failed:', uploadError.message);
          continue;
        }

        await client.from('rfq_submission_documents').insert([{
          submission_id: submissionId,
          file_name: file.name,
          file_path: filePath,
          file_size: file.size,
          document_type: 'Quotation'
        }]);

        quotesUploaded++;
        filesUploaded++;
      } catch (quoteErr) {
        console.warn('⚠️ Error uploading quotation:', quoteErr.message);
      }
    }

    if (quotesUploaded === 0) {
      showToast('⚠️ Your application was submitted but the quotation did not upload. Please contact the issuer.', 'error');
    }

    // Upload optional additional documents (multiple files allowed)
    const optionalDocInput = document.getElementById('contractor-optional-docs');
    if (optionalDocInput && optionalDocInput.files && optionalDocInput.files.length > 0) {
      for (let file of optionalDocInput.files) {
        try {
          const timestamp = Date.now() + Math.random(); // Ensure unique names for multiple files
          const filePath = `rfq-${currentRFQId}/sub-${submissionId}/${timestamp}-${sanitizeStorageFileName(file.name)}`;

          const { error: uploadError } = await client.storage
            .from('rfq-documents')
            .upload(filePath, file);

          if (uploadError) {
            console.warn('⚠️ Optional document upload failed:', uploadError.message);
            continue;
          }

          await client.from('rfq_submission_documents').insert([{
            submission_id: submissionId,
            file_name: file.name,
            file_path: filePath,
            file_size: file.size,
            document_type: 'Supplementary Document',
            is_optional: true
          }]);

          filesUploaded++;
        } catch (optErr) {
          console.warn('⚠️ Error uploading optional document:', optErr.message);
        }
      }
    }

    // Record each successfully-reused document too — same table, same shape
    // as a freshly-uploaded one, just pointed at the copy the Edge Function
    // made and flagged so Review Submissions can badge it as reused rather
    // than something the contractor uploaded fresh. A doc the applicant
    // picked "reuse" for but that failed to copy would have already aborted
    // the whole submission above if it was mandatory; a non-mandatory one
    // that failed is simply skipped here, same as any other optional
    // document that never made it in.
    for (const sel of reuseSelections) {
      const result = reuseResults[sel.category];
      if (!result || !result.success) continue;
      try {
        await client.from('rfq_submission_documents').insert([{
          submission_id: submissionId,
          file_name: result.fileName,
          file_path: result.filePath,
          file_size: result.fileSize,
          document_type: sel.documentName,
          expiry_date: null,
          reused_from_supplier_profile: true
        }]);
        filesUploaded++;
      } catch (reusedInsertErr) {
        console.warn('⚠️ Error recording reused document:', reusedInsertErr.message);
      }
    }

    // Mark token as used (only applies to invite-link applications; direct
    // public-portal applications have no invitation token to update).
    if (token) {
      await client
        .from('rfq_invitations')
        .update({ used: true })
        .eq('invitation_token', token);

      console.log('✅ Token marked as used');
    }

    showToast('✅ Submission successful!', 'success');

    // Best-effort confirmation email — the submission is already saved either
    // way, so a failure here (e.g. Resend hiccup) shouldn't interrupt the UX.
    const refCode = `RFQ-${currentRFQId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
    callPublicEdgeFunction('send-application-confirmation', {
      submissionId: submissionId,
      rfqId: currentRFQId,
      rfqName: currentRFQData ? currentRFQData.rfq_name : 'RFQ',
      refCode: refCode,
      contractorName: name,
      contractorEmail: email,
      companyName: currentRFQCompanyName || 'the company'
    }).catch(err => console.error('send-application-confirmation failed:', err));

    setTimeout(() => {
      document.getElementById('rfq-portal').innerHTML = '<div class="card"><h2 style="margin-top:0; color:var(--success);">Thank You!</h2><p>Your submission has been received. A confirmation email has been sent to ' + email + '.</p></div>';
    }, 1000);

  } catch (err) {
    console.error('Error submitting:', err);
    // A suspended/removed supplier's insert is rejected at the DB level
    // (rfq_submissions' insert RLS policy) — this is the real enforcement,
    // the disabled Submit button above is just a heads-up. Surface that
    // specific case with a clear message instead of the raw Postgres
    // "row violates row-level security policy" text.
    if (err && err.code === '42501') {
      showToast('❌ Your supplier registration doesn\'t allow applying to RFQs right now. Please contact us for details.', 'error');
    } else {
      showToast('Error: ' + err.message, 'error');
    }
  }
}

// Shows the company's logo next to its name in the dashboard header bar
// (distinct from the site-wide masthead logo) so the page feels like it
// belongs to that company. Hides the <img> entirely when there's no logo.
function updateAdminHeaderLogo(company) {
  const img = document.getElementById('admin-header-logo');
  if (!img) return;
  if (company && company.logo_url) {
    img.src = company.logo_url;
    img.alt = company.name || '';
    img.style.display = 'block';
  } else {
    img.style.display = 'none';
    img.src = '';
  }
}

// ===== ADMIN VIEW (Company Dashboard) =====
function showAdminView() {
  hideAllTopLevelViews();
  document.getElementById('admin-view').style.display = 'block';

  document.getElementById('admin-company-name').textContent = currentCompany ? currentCompany.name : 'RFQ Management';
  updateAdminHeaderLogo(currentCompany);
  applyCompanyBranding(currentCompany, {
    heroTitle: currentCompany ? currentCompany.name : 'RFQ Hub',
    heroSubtitle: 'Manage your RFQs, contractor invitations, and submissions.'
  });

  const superLink = document.getElementById('super-admin-link');
  if (superLink) superLink.style.display = isSuperAdmin ? 'inline' : 'none';

  document.getElementById('create-tab').style.display = 'block';
  document.getElementById('console-tab').style.display = 'none';
  document.getElementById('submissions-tab').style.display = 'none';
  document.getElementById('team-tab').style.display = 'none';
  document.getElementById('settings-tab').style.display = 'none';

  document.querySelectorAll('.company-tab-btn').forEach((btn, idx) => {
    btn.classList.toggle('active', idx === 0);
  });
}

function switchAdminTab(tabName, button) {
  document.querySelectorAll('.admin-tab').forEach(tab => tab.style.display = 'none');
  document.querySelectorAll('.company-tab-btn').forEach(btn => btn.classList.remove('active'));

  document.getElementById(tabName + '-tab').style.display = 'block';
  if (button) button.classList.add('active');

  if (tabName === 'console') {
    loadRFQConsole();
  } else if (tabName === 'submissions') {
    loadSubmissions();
  } else if (tabName === 'team') {
    loadTeamMembers();
  } else if (tabName === 'settings') {
    loadSettingsTab();
  }
}

// Super Admin dashboard uses its own tab/button classes (.super-tab /
// .super-tab-btn) so switching a tab here never touches the company
// admin dashboard's tab state, and vice versa — the two dashboards can
// be left on different sections without clobbering each other.
// ===== PLATFORM ADMIN — ALL RFQs =====
// A read-only register of every RFQ on the platform: which company issued it,
// when it went public and when it closes. Exists so that when a supplier queries a tender, admin can
// answer without opening each company's own dashboard. Nothing here edits an
// RFQ — the owning company's console remains the only place to do that.
let allSuperAdminRFQs = [];
let filteredSuperAdminRFQs = [];

// Derived, not stored: the table keeps four independent booleans plus a
// deadline, and the label a human wants is the combination of them.
function rfqListingStatus(rfq) {
  if (rfq.is_withdrawn) return { label: 'Withdrawn', color: '#B23B2E', bg: '#FDECEA' };
  if (rfq.is_draft || !rfq.is_released) return { label: 'Draft', color: '#6B7280', bg: '#F1F3F5' };
  if (!rfq.is_public) return { label: 'Invite only', color: '#0F3557', bg: '#E8EEF5' };
  const deadline = rfq.deadline ? new Date(rfq.deadline) : null;
  if (deadline && !isNaN(deadline.getTime()) && deadline < new Date()) {
    return { label: 'Closed', color: '#6B7280', bg: '#F1F3F5' };
  }
  return { label: 'Open', color: '#2E6B4F', bg: '#E8F3EC' };
}


// The date the RFQ actually went public. released_at is the real answer;
// created_at is only a fallback for older rows released before that column
// was being written, and is never shown for something still in draft.
function rfqListedDate(rfq) {
  return rfq.released_at || (rfq.is_released ? rfq.created_at : null);
}

function formatAdminDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
}

async function loadSuperAdminRFQs() {
  const listEl = document.getElementById('super-admin-rfqs-list');
  if (!listEl) return;
  listEl.innerHTML = '<p style="color:var(--border); padding:20px 0;">Loading…</p>';

  try {
    // is_super_admin() short-circuits the rfqs_select_scoped policy, so this
    // returns every company's RFQs including drafts and withdrawn ones.
    const { data: rfqs, error } = await client
      .from('rfqs')
      .select('id, rfq_name, project_name, company_id, deadline, created_at, released_at, is_draft, is_released, is_public, is_withdrawn, provinces, location_area')
      .order('released_at', { ascending: false, nullsFirst: false });
    if (error) throw error;

    const { data: companies } = await client.from('companies').select('id, name');
    const companyById = new Map((companies || []).map(c => [c.id, c.name]));

    // Application counts. A super admin can read every submission, so this is
    // a complete tally — but if the query ever fails the column shows a dash
    // rather than a zero, because a wrong zero reads as "nobody applied".
    let countByRfq = null;
    try {
      const { data: subs, error: subErr } = await client.from('rfq_submissions').select('rfq_id');
      if (subErr) throw subErr;
      countByRfq = new Map();
      (subs || []).forEach(s => countByRfq.set(s.rfq_id, (countByRfq.get(s.rfq_id) || 0) + 1));
    } catch (countErr) {
      console.warn('RFQ register: could not load application counts:', countErr.message);
    }

    allSuperAdminRFQs = (rfqs || []).map(r => ({
      ...r,
      company_name: companyById.get(r.company_id) || 'Unknown',
      application_count: countByRfq ? (countByRfq.get(r.id) || 0) : null
    }));

    const issuerFilter = document.getElementById('rfq-register-issuer-filter');
    if (issuerFilter) {
      const previous = issuerFilter.value;
      const names = Array.from(new Set(allSuperAdminRFQs.map(r => r.company_name))).sort();
      issuerFilter.innerHTML = '<option value="">All Issuers</option>' +
        names.map(n => `<option value="${escapeHtmlClient(n)}">${escapeHtmlClient(n)}</option>`).join('');
      issuerFilter.value = names.indexOf(previous) !== -1 ? previous : '';
    }

    filterSuperAdminRFQs();
  } catch (err) {
    console.error('Error loading RFQ register:', err);
    listEl.innerHTML = '<p style="color:#B23B2E; padding:20px 0;">Could not load the RFQ list: ' + escapeHtmlClient(err.message) + '</p>';
  }
}

function filterSuperAdminRFQs() {
  const searchEl = document.getElementById('rfq-register-search');
  const issuerEl = document.getElementById('rfq-register-issuer-filter');
  const statusEl = document.getElementById('rfq-register-status-filter');

  const term = (searchEl ? searchEl.value : '').trim().toLowerCase();
  const issuer = issuerEl ? issuerEl.value : '';
  const status = statusEl ? statusEl.value : '';

  filteredSuperAdminRFQs = allSuperAdminRFQs.filter(r => {
    if (issuer && r.company_name !== issuer) return false;
    if (status && rfqListingStatus(r).label !== status) return false;
    if (!term) return true;
    return [r.rfq_name, r.project_name, r.company_name, r.location_area]
      .filter(Boolean)
      .some(v => String(v).toLowerCase().indexOf(term) !== -1);
  });

  renderSuperAdminRFQs(filteredSuperAdminRFQs);
}

function renderSuperAdminRFQs(list) {
  const el = document.getElementById('super-admin-rfqs-list');
  if (!el) return;

  const countEl = document.getElementById('rfq-register-count');
  if (countEl) {
    countEl.textContent = list.length === allSuperAdminRFQs.length
      ? `${allSuperAdminRFQs.length} RFQ${allSuperAdminRFQs.length === 1 ? '' : 's'}`
      : `${list.length} of ${allSuperAdminRFQs.length} RFQs`;
  }

  if (!list.length) {
    el.innerHTML = `<p style="text-align:center; color:var(--border); padding:40px 0;">${allSuperAdminRFQs.length ? 'No RFQs match this filter' : 'No RFQs have been listed yet'}</p>`;
    return;
  }

  const rows = list.map(r => {
    const s = rfqListingStatus(r);
    return `
        <tr style="border-bottom:1px solid var(--border);">
          <td style="padding:10px 12px; vertical-align:top;">
            <strong style="color:var(--ink);">${escapeHtmlClient(r.rfq_name || 'Untitled')}</strong>
            ${r.project_name ? `<div style="font-size:12px; color:var(--border);">${escapeHtmlClient(r.project_name)}</div>` : ''}
          </td>
          <td style="padding:10px 12px; vertical-align:top;">${escapeHtmlClient(r.company_name)}</td>
          <td style="padding:10px 12px; vertical-align:top; white-space:nowrap;">${formatAdminDate(rfqListedDate(r))}</td>
          <td style="padding:10px 12px; vertical-align:top; white-space:nowrap;">${formatAdminDate(r.deadline)}</td>
          <td style="padding:10px 12px; vertical-align:top; white-space:nowrap;">
            <span style="display:inline-block; padding:2px 10px; border-radius:10px; font-size:12px; font-weight:bold; color:${s.color}; background:${s.bg};">${s.label}</span>
          </td>
          <td style="padding:10px 12px; vertical-align:top; text-align:right;">${r.application_count === null ? '—' : r.application_count}</td>
        </tr>`;
  }).join('');

  el.innerHTML = `
      <div style="overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:14px;">
          <thead>
            <tr style="background:var(--bg-2); text-align:left;">
              <th style="padding:10px 12px;">RFQ</th>
              <th style="padding:10px 12px;">Issued by</th>
              <th style="padding:10px 12px;">Listed</th>
              <th style="padding:10px 12px;">Closes</th>
              <th style="padding:10px 12px;">Status</th>
              <th style="padding:10px 12px; text-align:right;">Apps</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
}

// Exports what's currently on screen rather than the whole register, so a
// filtered view downloads as exactly that.
function exportRFQRegisterAsCSV() {
  const list = filteredSuperAdminRFQs.length ? filteredSuperAdminRFQs : allSuperAdminRFQs;
  if (!list.length) {
    showToast('❌ No RFQs to export', 'error');
    return;
  }
  const q = (v) => `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;
  const headers = ['RFQ Name', 'Project', 'Issued By', 'Listed', 'Closes', 'Status', 'Applications', 'Location', 'Provinces'];
  const rows = list.map(r => [
    q(r.rfq_name),
    q(r.project_name),
    q(r.company_name),
    q(formatAdminDate(rfqListedDate(r))),
    q(formatAdminDate(r.deadline)),
    q(rfqListingStatus(r).label),
    r.application_count === null ? '' : r.application_count,
    q(r.location_area),
    q(Array.isArray(r.provinces) ? r.provinces.join('; ') : '')
  ].join(','));

  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.setAttribute('href', url);
  link.setAttribute('download', `RFQ_Register_${new Date().toISOString().split('T')[0]}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  showToast('✅ RFQ list exported as CSV', 'success');
}

// ===== PLATFORM ADMIN — NOTIFICATIONS ONLY =====
// Contacts who should hear about every RFQ published on the platform without
// being suppliers: no documents, no login, no applications, no supplier number.
// They live in their own table (notification_subscribers) rather than as
// applicant_registrations rows, so they can never be mistaken for registered
// suppliers — not in the Supplier Database, not in a supplier export, not in
// the registered-supplier count.
let allNotificationSubscribers = [];

async function loadNotificationSubscribers() {
  const el = document.getElementById('notification-subscribers-list');
  if (!el) return;
  el.innerHTML = '<p style="color:var(--border); padding:16px 0;">Loading…</p>';
  try {
    const { data, error } = await client
      .from('notification_subscribers')
      .select('*')
      .order('full_name', { ascending: true });
    if (error) throw error;
    allNotificationSubscribers = data || [];
    renderNotificationSubscribers();
  } catch (err) {
    console.error('Error loading notification contacts:', err);
    el.innerHTML = '<p style="color:#B23B2E; padding:16px 0;">Could not load the list: ' + escapeHtmlClient(err.message) + '</p>';
  }
}

function renderNotificationSubscribers() {
  const el = document.getElementById('notification-subscribers-list');
  if (!el) return;

  const list = allNotificationSubscribers;
  if (!list.length) {
    el.innerHTML = '<p style="text-align:center; color:var(--border); padding:30px 0;">No notification contacts yet. Add one above.</p>';
    return;
  }

  const rows = list.map(s => {
    const paused = s.status === 'paused';
    return `
        <tr style="border-bottom:1px solid var(--border);${paused ? ' opacity:0.55;' : ''}">
          <td style="padding:10px 12px;"><strong style="color:var(--ink);">${escapeHtmlClient(s.full_name)}</strong></td>
          <td style="padding:10px 12px;">${escapeHtmlClient(s.email)}</td>
          <td style="padding:10px 12px; white-space:nowrap;">${s.province === 'ALL' ? 'All provinces' : escapeHtmlClient(s.province)}</td>
          <td style="padding:10px 12px; white-space:nowrap;">
            <span style="display:inline-block; padding:2px 10px; border-radius:10px; font-size:12px; font-weight:bold; color:${paused ? '#6B7280' : '#2E6B4F'}; background:${paused ? '#F1F3F5' : '#E8F3EC'};">${paused ? 'Paused' : 'Active'}</span>
          </td>
          <td style="padding:10px 12px; text-align:right; white-space:nowrap;">
            <button type="button" class="btn secondary" style="padding:4px 12px; font-size:12px;" onclick="toggleNotificationSubscriber('${s.id}')">${paused ? 'Resume' : 'Pause'}</button>
            <button type="button" class="btn secondary" style="padding:4px 12px; font-size:12px; margin-left:6px;" onclick="removeNotificationSubscriber('${s.id}')">Remove</button>
          </td>
        </tr>`;
  }).join('');

  const activeCount = list.filter(s => s.status !== 'paused').length;

  el.innerHTML = `
      <p style="font-size:13px; color:var(--border); margin:0 0 10px 0;">${activeCount} active of ${list.length} contact${list.length === 1 ? '' : 's'}.</p>
      <div style="overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:14px;">
          <thead>
            <tr style="background:var(--bg-2); text-align:left;">
              <th style="padding:10px 12px;">Name</th>
              <th style="padding:10px 12px;">Email</th>
              <th style="padding:10px 12px;">Provinces</th>
              <th style="padding:10px 12px;">Status</th>
              <th style="padding:10px 12px; text-align:right;">&nbsp;</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
}

async function handleAddSubscriberSubmit(e) {
  if (e) e.preventDefault();

  const nameEl = document.getElementById('subscriber-name');
  const emailEl = document.getElementById('subscriber-email');
  const provinceEl = document.getElementById('subscriber-province');
  const submitBtn = document.getElementById('add-subscriber-btn');

  const full_name = (nameEl ? nameEl.value : '').trim();
  const email = (emailEl ? emailEl.value : '').trim().toLowerCase();
  const province = provinceEl ? provinceEl.value : 'ALL';

  if (!full_name || !email) {
    showToast('❌ Please enter both a name and an email address', 'error');
    return;
  }

  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Adding...'; }

  try {
    const { error } = await client
      .from('notification_subscribers')
      .insert({ full_name, email, province, created_by: (currentUser && currentUser.email) || null });

    if (error) {
      // 23505 is the unique index on lower(email) — this person is already on
      // the list, which is worth saying plainly rather than as a raw error.
      if (error.code === '23505') {
        showToast('❌ That email address is already on the notifications list', 'error');
      } else {
        throw error;
      }
    } else {
      showToast(`✅ ${full_name} will be notified when new RFQs are published`, 'success');
      if (nameEl) nameEl.value = '';
      if (emailEl) emailEl.value = '';
      if (provinceEl) provinceEl.value = 'ALL';
      await loadNotificationSubscribers();
    }
  } catch (err) {
    console.error('Error adding notification contact:', err);
    showToast('❌ Could not add this contact: ' + err.message, 'error');
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Add Contact'; }
  }
}

// Pausing keeps the person on the list but takes them out of the notifier's
// query — useful for someone on leave, and reversible without re-typing their
// details.
async function toggleNotificationSubscriber(id) {
  const row = allNotificationSubscribers.find(s => s.id === id);
  if (!row) return;
  const next = row.status === 'paused' ? 'active' : 'paused';
  try {
    const { error } = await client
      .from('notification_subscribers')
      .update({ status: next })
      .eq('id', id);
    if (error) throw error;
    showToast(next === 'paused' ? `⏸️ ${row.full_name} paused` : `✅ ${row.full_name} resumed`, 'success');
    await loadNotificationSubscribers();
  } catch (err) {
    console.error('Error updating notification contact:', err);
    showToast('❌ Could not update this contact: ' + err.message, 'error');
  }
}

async function removeNotificationSubscriber(id) {
  const row = allNotificationSubscribers.find(s => s.id === id);
  if (!row) return;
  if (!confirm(`Remove ${row.full_name} (${row.email}) from the notifications list? They will stop receiving new-RFQ emails immediately. You can add them again later.`)) return;
  try {
    const { error } = await client
      .from('notification_subscribers')
      .delete()
      .eq('id', id);
    if (error) throw error;
    showToast(`✅ ${row.full_name} removed from the notifications list`, 'success');
    await loadNotificationSubscribers();
  } catch (err) {
    console.error('Error removing notification contact:', err);
    showToast('❌ Could not remove this contact: ' + err.message, 'error');
  }
}

function switchSuperAdminTab(tabName, button) {
  document.querySelectorAll('.super-tab').forEach(tab => tab.style.display = 'none');
  document.querySelectorAll('.super-tab-btn').forEach(btn => btn.classList.remove('active'));

  document.getElementById(tabName + '-tab').style.display = 'block';
  if (button) button.classList.add('active');
}

// ===== SETTINGS =====
function loadSettingsTab() {
  if (!currentCompany) return;

  document.getElementById('settings-company-name').value = currentCompany.name || '';
  document.getElementById('settings-contact-email').value = currentCompany.contact_email || '';
  document.getElementById('settings-contact-phone').value = currentCompany.contact_phone || '';
  document.getElementById('settings-address').value = currentCompany.address || '';

  const preview = document.getElementById('settings-logo-preview');
  const placeholder = document.getElementById('settings-logo-placeholder');
  const scaleInput = document.getElementById('settings-logo-scale');
  const scaleLabel = document.getElementById('settings-logo-scale-label');

  const scale = currentCompany.logo_scale || 1;
  if (scaleInput) scaleInput.value = Math.round(scale * 100);
  if (scaleLabel) scaleLabel.textContent = `${Math.round(scale * 100)}%`;

  if (currentCompany.logo_url) {
    applyLogoScale(preview, scale);
    preview.src = currentCompany.logo_url;
    preview.style.display = 'block';
    placeholder.style.display = 'none';
  } else {
    preview.style.display = 'none';
    placeholder.style.display = 'flex';
  }
}

function handleSettingsLogoScaleInput(e) {
  const pct = Number(e.target.value);
  const label = document.getElementById('settings-logo-scale-label');
  if (label) label.textContent = `${pct}%`;
  const preview = document.getElementById('settings-logo-preview');
  if (preview && preview.style.display !== 'none') {
    applyLogoScale(preview, pct / 100);
  }
}

async function handleSettingsLogoScaleChange(e) {
  if (!currentCompany) return;
  const pct = Number(e.target.value);
  const scale = Math.min(1.5, Math.max(0.5, pct / 100));
  try {
    const { error } = await client
      .from('companies')
      .update({ logo_scale: scale, updated_at: new Date().toISOString() })
      .eq('id', currentCompany.id);
    if (error) throw error;

    currentCompany.logo_scale = scale;

    // Live-update the real header logo too, without disturbing the
    // title/subtitle text currently shown there.
    const brandImg = document.getElementById('brand-logo-img');
    if (brandImg && brandImg.style.display !== 'none') {
      applyLogoScale(brandImg, scale);
    }

    showToast('✅ Logo size saved', 'success');
  } catch (err) {
    console.error('Error saving logo size:', err);
    showToast('❌ Error saving logo size: ' + err.message, 'error');
  }
}

async function handleLogoFileChange(e) {
  const file = e.target.files[0];
  if (!file || !currentCompany) return;

  try {
    showToast('Uploading logo...', 'info');
    const ext = (file.name.split('.').pop() || 'png').toLowerCase();
    const path = `${currentCompany.id}/logo-${Date.now()}.${ext}`;

    const { error: uploadError } = await client.storage
      .from('company-logos')
      .upload(path, file, { upsert: true });
    if (uploadError) throw uploadError;

    const { data: urlData } = client.storage.from('company-logos').getPublicUrl(path);
    const logoUrl = urlData.publicUrl;

    const { error: updateError } = await client
      .from('companies')
      .update({ logo_url: logoUrl, updated_at: new Date().toISOString() })
      .eq('id', currentCompany.id);
    if (updateError) throw updateError;

    currentCompany.logo_url = logoUrl;
    loadSettingsTab();
    document.getElementById('admin-company-name').textContent = currentCompany.name;
    updateAdminHeaderLogo(currentCompany);
    applyCompanyBranding(currentCompany, {
      heroTitle: currentCompany.name,
      heroSubtitle: 'Manage your RFQs, contractor invitations, and submissions.'
    });

    showToast('✅ Logo updated!', 'success');
  } catch (err) {
    console.error('Logo upload error:', err);
    showToast('Error uploading logo: ' + err.message, 'error');
  }
}

async function handleSettingsSubmit(e) {
  e.preventDefault();
  if (!currentCompany) return;

  const name = document.getElementById('settings-company-name').value.trim();
  const contactEmail = document.getElementById('settings-contact-email').value.trim();
  const contactPhone = document.getElementById('settings-contact-phone').value.trim();
  const address = document.getElementById('settings-address').value.trim();

  if (!name) {
    showToast('Company name is required', 'error');
    return;
  }

  try {
    const { error } = await client
      .from('companies')
      .update({
        name,
        contact_email: contactEmail || null,
        contact_phone: contactPhone || null,
        address: address || null,
        updated_at: new Date().toISOString()
      })
      .eq('id', currentCompany.id);
    if (error) throw error;

    currentCompany.name = name;
    currentCompany.contact_email = contactEmail;
    currentCompany.contact_phone = contactPhone;
    currentCompany.address = address;

    document.getElementById('admin-company-name').textContent = name;
    updateAdminHeaderLogo(currentCompany);
    applyCompanyBranding(currentCompany, {
      heroTitle: name,
      heroSubtitle: 'Manage your RFQs, contractor invitations, and submissions.'
    });

    showToast('✅ Settings saved!', 'success');
  } catch (err) {
    console.error('Error saving settings:', err);
    showToast('Error saving settings: ' + err.message, 'error');
  }
}

// ===== CREATE RFQ =====
function setupCreateRFQForm() {
  const form = document.getElementById('create-rfq-form');
  if (form) {
    form.addEventListener('submit', createNewRFQ);
    console.log('✅ Create RFQ form found and hooked up');
  }

  document.querySelectorAll('input[name="rfq_visibility"]').forEach(radio => {
    radio.addEventListener('change', updateVisibilityHint);
  });
  updateVisibilityHint();
  renderStandardDocPicker();
}

// Reads the Create RFQ form's current values without validating or saving
// anything. Shared by createNewRFQ() (publish), saveRFQDraft(), and
// previewRFQ() so all three always agree on exactly what "the form" says —
// a value read one way for publishing and another way for preview would be
// a subtle, hard-to-notice bug.
function collectRFQFormValues() {
  const nameInput = document.querySelector('input[name="rfq_name"]');
  const projectInput = document.querySelector('input[name="rfq_project"]');
  const descInput = document.querySelector('textarea[name="rfq_description"]');
  const deadlineInput = document.querySelector('input[name="rfq_deadline"]');
  const budgetInput = document.querySelector('input[name="rfq_budget"]');
  const emailInput = document.querySelector('textarea[name="contractor_emails"]');
  const visibilityInput = document.querySelector('input[name="rfq_visibility"]:checked');
  const locationAreaInput = document.querySelector('input[name="rfq_location_area"]');

  const name = nameInput?.value?.trim() || '';
  const project = projectInput?.value?.trim() || '';
  const description = descInput?.value?.trim() || '';
  const deadline = deadlineInput?.value?.trim() || '';
  const budget = budgetInput?.value?.trim() || '';
  const emailsText = emailInput?.value?.trim() || '';
  const isPublic = (visibilityInput?.value || 'closed') === 'open';
  const provinces = Array.from(document.querySelectorAll('.rfq-province-checkbox:checked')).map(cb => cb.value);
  const locationArea = locationAreaInput?.value?.trim() || '';

  // Local preference
  const localPreferenceInput = document.querySelector('input[name="rfq_local_preference"]:checked');
  const isLocalPreference = (localPreferenceInput?.value || 'local') === 'local';
  const nonLocalReasonInput = document.querySelector('textarea[name="rfq_non_local_reason"]');
  const nonLocalReason = nonLocalReasonInput?.value?.trim() || null;

  const contractorEmails = emailsText
    .split('\n')
    .map(e => e.trim())
    .filter(e => e.length > 0);

  const docRows = document.querySelectorAll('#required-docs-builder .doc-row');
  const requiredDocs = Array.from(docRows)
    .map(row => {
      const docNameInput = row.querySelector('.doc-field');
      const docName = docNameInput && docNameInput.value ? docNameInput.value.trim() : '';
      if (!docName) return null;
      const mandatoryInput = row.querySelector('.doc-mandatory-field');
      const expiryInput = row.querySelector('.doc-expiry-field');
      const categoryInput = row.querySelector('.doc-supplier-category-field');
      const requiresExpiry = !!(expiryInput && expiryInput.checked);
      // Mutually exclusive with requires_expiry (enforced in the form UI
      // too — see addDocumentField()): a reused Supplier Database document
      // never carries its own expiry date, so it can never satisfy a
      // required-document row that demands one.
      const supplierDocCategory = (!requiresExpiry && categoryInput && categoryInput.value) ? categoryInput.value : null;
      const doc = {
        name: docName,
        mandatory: !!(mandatoryInput && mandatoryInput.checked),
        requires_expiry: requiresExpiry
      };
      if (supplierDocCategory) doc.supplier_doc_category = supplierDocCategory;
      return doc;
    })
    .filter(Boolean);

  return { name, project, description, deadline, budget, contractorEmails, isPublic, provinces, locationArea, requiredDocs, isLocalPreference, nonLocalReason };
}

function updateVisibilityHint() {
  const checked = document.querySelector('input[name="rfq_visibility"]:checked');
  const isPublic = checked && checked.value === 'open';
  const label = document.getElementById('contractor-emails-label');
  const hint = document.getElementById('contractor-emails-hint');
  if (!label || !hint) return;

  if (isPublic) {
    label.textContent = 'Contractor Email Addresses (optional)';
    hint.textContent = "Optional for Open RFQs — anyone can find and apply via the public portal. Add emails here only if you also want to invite specific contractors directly.";
  } else {
    label.textContent = 'Contractor Email Addresses *';
    hint.textContent = 'Enter email addresses (one per line). Each gets a direct invite link and email. Required for Closed RFQs.';
  }
}

// Categories already used by a required-document row in the builder —
// whether added via the standard picker (data-standard-category on the
// row) or manually linked on a custom row's doc-supplier-category-field.
// Used to keep the same Supplier Database document from being wired up
// to two different required-document rows on one RFQ, which would make
// the "document on file" reuse offer ambiguous.
function getUsedSupplierDocCategories() {
  const used = new Set();
  document.querySelectorAll('#required-docs-builder .doc-row').forEach(row => {
    if (row.dataset.standardCategory) {
      used.add(row.dataset.standardCategory);
      return;
    }
    const categoryInput = row.querySelector('.doc-supplier-category-field');
    if (categoryInput && categoryInput.value) used.add(categoryInput.value);
  });
  return used;
}

// Refreshes the "+ Add Standard Document" dropdown to list only the
// standard Supplier Database categories not already added to this RFQ's
// required-documents list, and any custom row's own linking dropdown
// (skipping its own currently-selected value, so re-rendering doesn't
// knock out what that row already has picked).
function renderStandardDocPicker() {
  const picker = document.getElementById('standard-doc-picker');
  if (!picker) return;
  const used = getUsedSupplierDocCategories();
  const available = SUPPLIER_DOC_CATEGORIES.filter(c => !used.has(c.category));
  picker.innerHTML = available.map(c => `<option value="${c.category}">${c.label}${c.mandatory ? ' (Mandatory)' : ''}</option>`).join('');
  picker.disabled = available.length === 0;
  const addBtn = picker.nextElementSibling;
  if (addBtn && addBtn.tagName === 'BUTTON') addBtn.disabled = available.length === 0;

  document.querySelectorAll('#required-docs-builder .doc-row:not([data-standard-category]) .doc-supplier-category-field').forEach(select => {
    const current = select.value;
    const options = ['<option value="">— Not linked (contractor always uploads fresh) —</option>']
      .concat(SUPPLIER_DOC_CATEGORIES
        .filter(c => c.category === current || !used.has(c.category))
        .map(c => `<option value="${c.category}">${c.label}</option>`));
    select.innerHTML = options.join('');
    select.value = current;
  });
}

// Adds a required-document row for one of the 7 standard Supplier
// Database categories (see SUPPLIER_DOC_CATEGORIES). The document's
// heading always matches that category's label verbatim — kept
// non-editable here so it stays in sync with the Supplier Database
// screen and the self-service preferences page, instead of drifting
// into ad-hoc per-RFQ wording. Mandatory defaults from the category but
// stays editable per-RFQ; Requires Expiry Date is off by default and,
// same as a custom row, clears the reuse link when turned on (a document
// already on file never carries a per-RFQ expiry date).
function addStandardDocumentField(category, overrides) {
  const entry = SUPPLIER_DOC_CATEGORIES.find(c => c.category === category);
  if (!entry) return;
  const builder = document.getElementById('required-docs-builder');
  const field = document.createElement('div');
  field.className = 'doc-row';
  field.dataset.standardCategory = category;
  field.style.cssText = 'border:1px solid var(--border); border-radius:6px; padding:10px; margin-bottom:10px; background:var(--bg-2);';
  field.innerHTML = `
    <div style="display:flex; gap:10px; margin-bottom:8px; align-items:center;">
      <span style="background:var(--primary); color:#fff; font-size:11px; font-weight:bold; padding:2px 8px; border-radius:10px;">STANDARD</span>
      <span style="flex:1; font-weight:600;">${entry.label}</span>
      <input type="hidden" class="doc-field" value="${entry.label}">
      <input type="hidden" class="doc-supplier-category-field" value="${category}">
      <button type="button" onclick="this.closest('.doc-row').remove(); renderStandardDocPicker();" class="btn secondary" style="padding:8px 12px;">Remove</button>
    </div>
    <div style="display:flex; gap:20px; flex-wrap:wrap; font-size:13px; color:var(--ink);">
      <label style="display:flex; align-items:center; gap:6px; font-weight:normal; cursor:pointer;">
        <input type="checkbox" class="doc-mandatory-field"${entry.mandatory ? ' checked' : ''}> Mandatory for submission
      </label>
      <label style="display:flex; align-items:center; gap:6px; font-weight:normal; cursor:pointer;">
        <input type="checkbox" class="doc-expiry-field"> Requires an expiry date (e.g. COIDA, insurance)
      </label>
    </div>
    <p style="margin:6px 0 0 0; font-size:11px; color:var(--border);">A registered supplier who already has this document on file can reuse it instead of uploading again. Turning on "Requires an expiry date" turns this off, since documents on file don't carry one.</p>
  `;
  const expiryCheckbox = field.querySelector('.doc-expiry-field');
  const categoryField = field.querySelector('.doc-supplier-category-field');
  expiryCheckbox.addEventListener('change', () => {
    categoryField.value = expiryCheckbox.checked ? '' : category;
  });
  builder.appendChild(field);

  if (overrides) {
    if (typeof overrides.mandatory === 'boolean') field.querySelector('.doc-mandatory-field').checked = overrides.mandatory;
    if (typeof overrides.requires_expiry === 'boolean') {
      expiryCheckbox.checked = overrides.requires_expiry;
      categoryField.value = overrides.requires_expiry ? '' : category;
    }
  }

  renderStandardDocPicker();
}

function addStandardDocumentFieldFromPicker() {
  const picker = document.getElementById('standard-doc-picker');
  if (!picker || !picker.value) return;
  addStandardDocumentField(picker.value);
}

function addDocumentField() {
  const builder = document.getElementById('required-docs-builder');
  const field = document.createElement('div');
  field.className = 'doc-row';
  field.style.cssText = 'border:1px solid var(--border); border-radius:6px; padding:10px; margin-bottom:10px;';
  field.innerHTML = `
    <div style="display:flex; gap:10px; margin-bottom:8px;">
      <input type="text" class="doc-field" placeholder="e.g., Insurance Certificate" style="flex:1; padding:8px; border:1px solid var(--border); border-radius:4px;">
      <button type="button" onclick="this.closest('.doc-row').remove()" class="btn secondary" style="padding:8px 12px;">Remove</button>
    </div>
    <div style="display:flex; gap:20px; flex-wrap:wrap; font-size:13px; color:var(--ink);">
      <label style="display:flex; align-items:center; gap:6px; font-weight:normal; cursor:pointer;">
        <input type="checkbox" class="doc-mandatory-field"> Mandatory for submission
      </label>
      <label style="display:flex; align-items:center; gap:6px; font-weight:normal; cursor:pointer;">
        <input type="checkbox" class="doc-expiry-field"> Requires an expiry date (e.g. COIDA, insurance)
      </label>
    </div>
    <div style="margin-top:8px;">
      <label style="display:block; font-size:12px; color:var(--border); margin-bottom:4px;">Matches a Supplier Database document?</label>
      <select class="doc-supplier-category-field" style="width:100%; max-width:320px; padding:6px; border:1px solid var(--border); border-radius:4px; font-size:13px;">
        <option value="">— Not linked (contractor always uploads fresh) —</option>
      </select>
      <p style="margin:4px 0 0 0; font-size:11px; color:var(--border);">If linked, a registered supplier who already has this document on file can reuse it instead of uploading again — they can still choose to upload a different file. Only offered when this document doesn't also require an expiry date, since documents on file don't carry one.</p>
    </div>
  `;
  const expiryCheckbox = field.querySelector('.doc-expiry-field');
  const categorySelect = field.querySelector('.doc-supplier-category-field');
  // A document can't both require an expiry date (which a reused profile
  // document can never supply) and be linked for reuse — keep the two
  // mutually exclusive right in the form so it's impossible to save an
  // inconsistent combination.
  expiryCheckbox.addEventListener('change', () => {
    if (expiryCheckbox.checked) {
      categorySelect.value = '';
      categorySelect.disabled = true;
    } else {
      categorySelect.disabled = false;
    }
    renderStandardDocPicker();
  });
  categorySelect.addEventListener('change', () => {
    if (categorySelect.value) {
      expiryCheckbox.checked = false;
      expiryCheckbox.disabled = true;
    } else {
      expiryCheckbox.disabled = false;
    }
    renderStandardDocPicker();
  });
  builder.appendChild(field);
  renderStandardDocPicker();
}

function resetCreateForm() {
  document.getElementById('create-rfq-form').reset();
  document.getElementById('required-docs-builder').innerHTML = '';
  document.getElementById('documents-list-section').style.display = 'none';
  rfqFilesToUpload = [];
  renderStandardDocPicker();
  currentDraftId = null;
  currentEditingIsDraft = true;
  currentEditingIsReleased = false;
  updateDraftEditingBanner();
}

// Shown above the Create RFQ form whenever it's currently editing an
// existing row (a saved draft, or an already-created RFQ loaded via
// editRFQ()) rather than starting a blank one, so it's never ambiguous
// whether Save/Publish will create a new row or update the one being
// edited. Also toggles the Save Draft button (hidden while editing an
// already-created RFQ, since saving a draft always sets is_draft:true, which
// would wrongly pull an already-published RFQ back off the public portal)
// and the "🚀 Publish RFQ" button (hidden only once this exact RFQ has
// already been released — see currentEditingIsReleased — since at that
// point there's nothing left to publish; Save Changes still works and stays
// silent). Publish RFQ never notifies/publishes by itself — it's a button,
// clicking it calls createNewRFQ(true) which saves the form first, then
// releases the freshly-saved row in the same action.
function updateDraftEditingBanner() {
  const banner = document.getElementById('draft-editing-banner');
  const saveDraftBtn = document.getElementById('save-draft-btn');
  const submitBtn = document.getElementById('create-rfq-submit-btn');
  const publishBtn = document.getElementById('publish-rfq-btn');

  if (!currentDraftId) {
    if (banner) banner.style.display = 'none';
    if (saveDraftBtn) saveDraftBtn.style.display = '';
    if (submitBtn) submitBtn.textContent = '💾 Save RFQ';
    if (publishBtn) publishBtn.style.display = '';
    return;
  }

  if (currentEditingIsDraft) {
    if (banner) {
      banner.style.display = 'block';
      banner.innerHTML = '📝 <strong>Editing a saved draft</strong> — Save Draft keeps it a draft, Save RFQ finalizes it into the Console, and <strong>🚀 Publish RFQ</strong> saves and makes it go live in one step. Nothing is sent to suppliers or contractors unless you click Publish RFQ (here or in the Console).';
    }
    if (saveDraftBtn) saveDraftBtn.style.display = '';
    if (submitBtn) submitBtn.textContent = '💾 Save RFQ';
    if (publishBtn) publishBtn.style.display = '';
  } else if (currentEditingIsReleased) {
    if (banner) {
      banner.style.display = 'block';
      banner.innerHTML = '✏️ <strong>Editing an already-released RFQ</strong> — saving updates it in place, silently. It\'s already live, so there\'s nothing further to publish here; use Unpublish/Expand Supplier Search in the Console for its visibility and notification reach.';
    }
    if (saveDraftBtn) saveDraftBtn.style.display = 'none';
    if (submitBtn) submitBtn.textContent = '💾 Save Changes';
    if (publishBtn) publishBtn.style.display = 'none';
  } else {
    if (banner) {
      banner.style.display = 'block';
      banner.innerHTML = '✏️ <strong>Editing an existing RFQ</strong> — Save Changes updates it in place, silently. Nothing is sent to suppliers or contractors unless you click <strong>🚀 Publish RFQ</strong> (here or in the Console).';
    }
    if (saveDraftBtn) saveDraftBtn.style.display = 'none';
    if (submitBtn) submitBtn.textContent = '💾 Save Changes';
    if (publishBtn) publishBtn.style.display = '';
  }
}

// Called two ways: as the Create/Edit form's submit handler (the Save/Save
// Draft-adjacent "Save RFQ"/"Save Changes" button, or Enter in the form),
// in which case the browser passes the submit Event in as the first
// argument and this always just saves; or directly from the "🚀 Publish
// RFQ" button's onclick as createNewRFQ(true), in which case it saves AND
// immediately releases in one step (see performRelease()). `eventOrRelease
// === true` is the only way `wantsRelease` becomes true — a real Event
// object is never `=== true`, so the two call sites can't be confused.
async function createNewRFQ(eventOrRelease) {
  const wantsRelease = eventOrRelease === true;

  if (isSubmittingRFQ) {
    console.log('⏳ Already submitting, please wait...');
    return;
  }

  if (!currentCompany) {
    showToast('❌ No company account loaded', 'error');
    return;
  }

  isSubmittingRFQ = true;

  try {
    console.log('=== CREATE RFQ STARTED ===', wantsRelease ? '(save + release)' : '(save only)');

    // Captured up front — resetCreateForm() at the end clears currentDraftId/
    // currentEditingIsDraft, so this is the only reliable point to remember
    // which of the three modes (new RFQ / publishing a draft / editing an
    // already-created RFQ) this submit actually is.
    const wasEditingExistingRfq = !!currentDraftId && !currentEditingIsDraft;

    // editRFQ() deliberately never repopulates the Contractor Emails
    // textarea (so a plain edit-and-save never re-sends/duplicates existing
    // invitations — see the comment on editRFQ() itself). That means an
    // empty textarea is completely normal and expected while editing an
    // existing Closed RFQ that already has contractors on file — it should
    // NOT be treated the same as "this Closed RFQ has zero contractors",
    // which really would be a problem. So when editing an existing RFQ,
    // check how many invitations already exist for it before deciding
    // whether an empty textarea is actually an error.
    let existingInvitationCount = 0;
    if (wasEditingExistingRfq) {
      const { count } = await client
        .from('rfq_invitations')
        .select('id', { count: 'exact', head: true })
        .eq('rfq_id', currentDraftId);
      existingInvitationCount = count || 0;
    }

    const { name, project, description, deadline, budget, contractorEmails, isPublic, provinces, locationArea, requiredDocs, isLocalPreference, nonLocalReason } = collectRFQFormValues();

    if (!name) {
      showToast('❌ Please enter RFQ Name', 'error');
      isSubmittingRFQ = false;
      return;
    }
    if (!project) {
      showToast('❌ Please enter Project Name', 'error');
      isSubmittingRFQ = false;
      return;
    }
    if (!description) {
      showToast('❌ Please enter Description', 'error');
      isSubmittingRFQ = false;
      return;
    }
    if (!deadline) {
      showToast('❌ Please select a Deadline', 'error');
      isSubmittingRFQ = false;
      return;
    }
    if (provinces.length === 0) {
      showToast('❌ Please select at least one Province', 'error');
      isSubmittingRFQ = false;
      return;
    }
    if (requiredDocs.length === 0) {
      showToast('❌ Please add at least one Required Document type', 'error');
      isSubmittingRFQ = false;
      return;
    }
    if (!isLocalPreference && !nonLocalReason) {
      showToast('❌ Please provide a reason for expanding beyond the local area', 'error');
      isSubmittingRFQ = false;
      return;
    }
    if (!isPublic && contractorEmails.length === 0 && existingInvitationCount === 0) {
      showToast('❌ Please enter at least one Contractor Email (required for Closed RFQs)', 'error');
      isSubmittingRFQ = false;
      return;
    }

    if (wantsRelease && !confirm('Save and release this RFQ? ' + (isPublic
      ? 'It will become publicly listed and registered suppliers will be notified by email/SMS.'
      : 'Its contractor invitation links will become active and any contractors on file will be emailed.'))) {
      isSubmittingRFQ = false;
      return;
    }

    console.log('✅ All validations passed');
    showToast(wantsRelease ? 'Saving and releasing...' : 'Saving...', 'success');

    const rfqPayload = {
      rfq_name: name,
      project_name: project,
      description: description,
      deadline: deadline,
      budget: budget || null,
      required_documents: requiredDocs,
      company_id: currentCompany.id,
      is_public: isPublic,
      is_draft: false,
      provinces: provinces,
      province: provinces[0] || null,
      location_area: locationArea || null,
      is_local_preference: isLocalPreference,
      non_local_reason: nonLocalReason,
      updated_at: new Date().toISOString()
      // Deliberately no `is_released` here, on either insert or update.
      // Saving (first time or any later edit) must never by itself make an
      // RFQ live — it only leaves an already-released RFQ's release state
      // untouched, and leaves a never-released one at its column default of
      // false. Going live (public listing, supplier notification, contractor
      // invite emails) only ever happens via the explicit releaseRFQ()
      // action in the Console. This is Brent's explicit requirement
      // (2026-08-24): nothing goes out — for Open or Closed RFQs — until
      // released, and saving/editing must be freely repeatable with zero
      // side effects.
    };

    let rfq;
    if (currentDraftId) {
      // Publishing a draft that was already saved earlier — update that
      // same row (and its id/links) rather than inserting a second one.
      const { data, error: rfqError } = await client
        .from('rfqs')
        .update(rfqPayload)
        .eq('id', currentDraftId)
        .select()
        .single();
      if (rfqError || !data) throw new Error(rfqError ? rfqError.message : 'Failed to publish draft');
      rfq = data;
    } else {
      const { data, error: rfqError } = await client
        .from('rfqs')
        .insert([{ ...rfqPayload, created_by: currentUser ? currentUser.email : 'unknown' }])
        .select()
        .single();
      if (rfqError || !data || !data.id) throw new Error(rfqError ? rfqError.message : 'Failed to create RFQ');
      rfq = data;
    }

    console.log('✅ RFQ saved:', rfq.id);

    await uploadRFQAttachments(rfq.id);

    // No notify-suppliers call here — that only ever happens from
    // releaseRFQ() now, whether this is the very first save of a brand new
    // RFQ or an edit to one that's already been released.

    if (contractorEmails.length > 0) {
      const invitations = contractorEmails.map(email => ({
        rfq_id: rfq.id,
        contractor_email: email,
        invitation_token: generateToken(),
        used: false
      }));

      const { error: invError } = await client
        .from('rfq_invitations')
        .insert(invitations);

      if (invError) throw invError;

      console.log('✅ Invitations created');

      window.lastInvitations = invitations;
      // Only actually email these contractors immediately if the RFQ is
      // already released or is about to be released in the next step below
      // — otherwise the links are created (so they're ready and previewable)
      // but stay unreachable (see rfqs_select_scoped) and unsent until a
      // release happens.
      if (!wantsRelease) {
        if (rfq.is_released) {
          await sendRFQInviteEmails(rfq.id, invitations);
        } else {
          showToast(`✅ Saved — ${invitations.length} contractor link(s) ready (emailed when released)`, 'success');
        }
      }
      showGeneratedLinks(rfq.id, invitations);
    }

    // The "🚀 Publish RFQ" path: release right after saving, in one step,
    // using the row we just saved (no extra fetch/confirm — that already
    // happened above). Skipped if this RFQ was already released before this
    // save (nothing left to do — see performRelease()/releaseRFQ()).
    let releaseInfo = null;
    if (wantsRelease && !rfq.is_released) {
      releaseInfo = await performRelease(rfq);
    }

    if (releaseInfo) {
      showToast('🚀 Saved and published' + (rfq.is_public ? ' — going out to registered suppliers now' : (releaseInfo.invitations.length > 0 ? ' — inviting contractors now' : '')), 'success');
    } else if (contractorEmails.length === 0) {
      if (wasEditingExistingRfq) {
        showToast('✅ Changes saved', 'success');
      } else {
        showToast(rfq.is_released ? '✅ Saved (already published)' : '✅ RFQ saved — click 🚀 Publish RFQ when ready', 'success');
      }
    }

    resetCreateForm();
    loadRFQConsole();

  } catch (err) {
    console.error('❌ Error creating RFQ:', err);
    showToast('Error: ' + err.message, 'error');
  } finally {
    isSubmittingRFQ = false;
  }
}

// Saves the Create RFQ form as a Draft: not visible on the public portal,
// no supplier notifications, no contractor invitations sent — just parked
// so it can be finished later. Only the fields the rfqs table itself
// requires (name/project/description/deadline) are enforced; everything
// else (provinces, required documents, visibility, contractor emails) can
// be filled in partially or left for later.
async function saveRFQDraft() {
  if (isSubmittingRFQ) {
    console.log('⏳ Already submitting, please wait...');
    return;
  }
  if (!currentCompany) {
    showToast('❌ No company account loaded', 'error');
    return;
  }
  // Defensive guard, not just UI hiding: this always sets is_draft:true, so
  // it must never run against an already-created RFQ being edited via
  // editRFQ() — that would silently pull a live/closed RFQ back into draft
  // status and off the public portal. The button itself is hidden in this
  // mode (see updateDraftEditingBanner()); this is the backstop.
  if (currentDraftId && !currentEditingIsDraft) {
    showToast('❌ This is an existing RFQ, not a draft — use Save Changes instead', 'error');
    return;
  }

  const { name, project, description, deadline, budget, isPublic, provinces, locationArea, requiredDocs, isLocalPreference, nonLocalReason } = collectRFQFormValues();

  if (!name || !project || !description || !deadline) {
    showToast('❌ RFQ Name, Project Name, Description, and Deadline are needed to save a draft', 'error');
    return;
  }

  isSubmittingRFQ = true;
  try {
    const rfqPayload = {
      rfq_name: name,
      project_name: project,
      description: description,
      deadline: deadline,
      budget: budget || null,
      required_documents: requiredDocs,
      company_id: currentCompany.id,
      is_public: isPublic,
      is_draft: true,
      provinces: provinces,
      province: provinces[0] || null,
      location_area: locationArea || null,
      is_local_preference: isLocalPreference,
      non_local_reason: nonLocalReason,
      updated_at: new Date().toISOString()
    };

    let rfq;
    if (currentDraftId) {
      const { data, error } = await client
        .from('rfqs')
        .update(rfqPayload)
        .eq('id', currentDraftId)
        .select()
        .single();
      if (error || !data) throw new Error(error ? error.message : 'Failed to save draft');
      rfq = data;
    } else {
      const { data, error } = await client
        .from('rfqs')
        .insert([{ ...rfqPayload, created_by: currentUser ? currentUser.email : 'unknown' }])
        .select()
        .single();
      if (error || !data || !data.id) throw new Error(error ? error.message : 'Failed to save draft');
      rfq = data;
      currentDraftId = rfq.id;
      updateDraftEditingBanner();
    }

    // Best-effort, same as publish — and self-guarding against duplicate
    // uploads: uploadRFQAttachments() only touches the attachments column
    // when the file input actually has files selected, and it's cleared
    // right after a successful upload, so re-clicking Save Draft without
    // picking new files won't re-upload (or lose) anything already stored.
    await uploadRFQAttachments(rfq.id);

    showToast('💾 Draft saved — it won\'t be visible to contractors until you publish it.', 'success');
    loadRFQConsole();
  } catch (err) {
    console.error('❌ Error saving draft:', err);
    showToast('Error: ' + err.message, 'error');
  } finally {
    isSubmittingRFQ = false;
  }
}

// Uploads any files queued in rfqFilesToUpload to the public rfq-attachments
// bucket and records them on the rfq row. Best-effort: a failed file doesn't
// stop the RFQ from being created. Merges onto whatever's already on the row.
async function uploadRFQAttachments(rfqId) {
  if (rfqFilesToUpload.length === 0) return;

  const uploaded = [];

  for (const fileInfo of rfqFilesToUpload) {
    try {
      const file = fileInfo.file;
      const path = `rfq-${rfqId}/${Date.now()}-${sanitizeStorageFileName(file.name)}`;
      const { error: uploadError } = await client.storage
        .from('rfq-attachments')
        .upload(path, file);

      if (uploadError) {
        console.warn('⚠️ Attachment upload failed:', file.name, uploadError.message);
        continue;
      }

      const { data: urlData } = client.storage.from('rfq-attachments').getPublicUrl(path);
      uploaded.push({ name: file.name, url: urlData.publicUrl });
    } catch (err) {
      console.warn('⚠️ Attachment upload error:', fileInfo.name, err.message);
    }
  }

  if (uploaded.length === 0) return;

  const { data: existingRfq } = await client
    .from('rfqs')
    .select('attachments')
    .eq('id', rfqId)
    .maybeSingle();
  const merged = [...((existingRfq && existingRfq.attachments) || []), ...uploaded];

  const { error: updateError } = await client
    .from('rfqs')
    .update({ attachments: merged })
    .eq('id', rfqId);

  if (updateError) {
    console.error('Error saving attachment list:', updateError);
    showToast('RFQ created, but attaching documents failed', 'warning');
  } else {
    // Clear the queued files after successful upload
    rfqFilesToUpload = [];
  }
}

// Tracks files being added to the current RFQ (both newly selected and existing)
let rfqFilesToUpload = []; // Array of {name, file, isNew, isExisting, url}

// Displays all attachments (existing and newly selected) in the RFQ form.
// Shows each attachment with delete and replace buttons.
function displayRFQAttachments(rfqId, existingAttachments) {
  const section = document.getElementById('documents-list-section');
  const list = document.getElementById('documents-list');

  // Combine existing attachments with newly selected files
  const allAttachments = [];

  // Add existing attachments
  if (existingAttachments && existingAttachments.length > 0) {
    existingAttachments.forEach((att, idx) => {
      allAttachments.push({
        name: att.name,
        url: att.url,
        isExisting: true,
        isNew: false,
        existingIdx: idx
      });
    });
  }

  // Add newly selected files
  rfqFilesToUpload.forEach((file, idx) => {
    allAttachments.push({
      name: file.name,
      isExisting: false,
      isNew: true,
      newIdx: idx
    });
  });

  if (allAttachments.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  list.innerHTML = allAttachments.map((att) => `
    <div style="display:flex; align-items:center; justify-content:space-between; padding:10px; background:var(--bg-2); border:1px solid var(--border); border-radius:4px;">
      <div style="flex:1; min-width:0;">
        <span style="color:var(--ink); word-break:break-word;">
          📄 ${escapeHtmlClient(att.name)}
          ${att.isNew ? '<span style="font-size:12px; color:var(--accent); margin-left:8px;">(new)</span>' : '<span style="font-size:12px; color:var(--border); margin-left:8px;">(existing)</span>'}
        </span>
      </div>
      <div style="display:flex; gap:6px; flex-shrink:0; margin-left:10px;">
        ${att.isNew ? `
          <button type="button" onclick="removeNewRFQFile(${att.newIdx})" class="btn secondary" style="padding:6px 12px; font-size:12px; color:var(--accent);">✕ Remove</button>
        ` : `
          <button type="button" onclick="deleteExistingRFQAttachment('${rfqId}', ${att.existingIdx})" class="btn secondary" style="padding:6px 12px; font-size:12px; color:var(--accent);">✕ Delete</button>
        `}
      </div>
    </div>
  `).join('');
}

// Remove a newly selected file from the upload list
function removeNewRFQFile(idx) {
  rfqFilesToUpload.splice(idx, 1);
  const rfqId = currentDraftId || 'new';
  displayRFQAttachments(rfqId, currentRFQData?.attachments || []);
}

// Deletes an existing attachment from the database.
async function deleteExistingRFQAttachment(rfqId, attachmentIdx) {
  if (!confirm('Delete this attachment? This cannot be undone.')) {
    return;
  }

  try {
    const { data: rfq } = await client
      .from('rfqs')
      .select('attachments')
      .eq('id', rfqId)
      .single();

    if (!rfq || !rfq.attachments || !rfq.attachments[attachmentIdx]) {
      showToast('❌ Attachment not found', 'error');
      return;
    }

    const attachment = rfq.attachments[attachmentIdx];

    // Delete the file from storage
    try {
      const urlParts = attachment.url.split('/object/public/rfq-attachments/');
      if (urlParts.length === 2) {
        const storagePath = decodeURIComponent(urlParts[1]);
        await client.storage
          .from('rfq-attachments')
          .remove([storagePath]);
      }
    } catch (err) {
      console.warn('⚠️ Storage cleanup error:', err.message);
    }

    // Remove from attachments array and update DB
    const updated = rfq.attachments.filter((_, i) => i !== attachmentIdx);
    await client
      .from('rfqs')
      .update({ attachments: updated })
      .eq('id', rfqId);

    showToast('✓ Attachment deleted', 'success');
    displayRFQAttachments(rfqId, updated);
  } catch (err) {
    console.error('Error deleting attachment:', err);
    showToast('❌ Error deleting attachment: ' + err.message, 'error');
  }
}

// Handle file selection in the file input - add files to upload list
function handleRFQFileInputChange(e) {
  const input = e.target;
  const files = input.files ? Array.from(input.files) : [];

  files.forEach(file => {
    rfqFilesToUpload.push({ name: file.name, file: file });
  });

  const rfqId = currentDraftId || 'new';
  displayRFQAttachments(rfqId, currentRFQData?.attachments || []);

  // Clear the input so the same file can be selected again if needed
  input.value = '';
}

// Renders a read-only preview of the RFQ exactly as a contractor would see
// it on the public/invite RFQ detail page (see loadRFQDetails()), but built
// entirely from whatever's currently typed into the Create RFQ form — no
// save, no network call. Deliberately NOT sharing markup/ids with
// loadRFQDetails() (e.g. no #contractor-form, no #doc-N inputs) so this can
// never collide with a real contractor page if both were somehow present in
// the same DOM, and so nothing here is mistaken for a live, submittable form.
function buildRFQPreviewCardHtml(values) {
  const { name, description, deadline, budget, provinces, locationArea, requiredDocs, isLocalPreference, nonLocalReason } = values;

  const companyName = (currentCompany && currentCompany.name) || 'Your Company';
  const logoUrl = currentCompany && currentCompany.logo_url;

  return `
    <div style="margin-bottom:16px; padding:10px 14px; background:#FFF8E1; border:1px solid #F5D67A; border-radius:4px; font-size:13px; color:var(--ink);">
      👁️ <strong>Preview</strong> — this is exactly how contractors will see this RFQ. Nothing has been saved yet.
    </div>
    <div class="card" style="box-shadow:none; border:1px solid var(--border);">
      <div style="display:flex; align-items:center; gap:12px; margin-bottom:20px;">
        ${logoUrl ? `<img src="${logoUrl}" alt="${escapeHtmlClient(companyName)}" style="height:40px; max-width:120px; object-fit:contain;">` : ''}
        <div>
          <p style="margin:0; font-weight:bold; color:var(--primary);">${escapeHtmlClient(companyName)}</p>
          <p style="margin:0; font-size:12px; color:var(--border);">Request for Quotation Portal</p>
        </div>
      </div>

      <h2 style="margin-top:0;">${name ? escapeHtmlClient(name) : '<span style="color:var(--border); font-style:italic;">(RFQ Name not yet entered)</span>'}</h2>
      <p style="color: var(--border); margin-bottom: 20px; white-space:pre-wrap;">${description ? escapeHtmlClient(description) : '<span style="font-style:italic;">(No description yet)</span>'}</p>

      ${(locationArea || (provinces && provinces.length > 0)) ? `<p><strong>Location:</strong> ${[locationArea, ...(provinces || [])].filter(Boolean).map(escapeHtmlClient).join(', ')}</p>` : ''}
      ${budget ? `<p><strong>Budget:</strong> R${escapeHtmlClient(String(budget))}</p>` : ''}
      ${deadline ? `<p><strong>Deadline:</strong> ${new Date(deadline).toLocaleDateString()}</p>` : '<p style="color:var(--border); font-style:italic;">(No deadline selected yet)</p>'}
      ${isLocalPreference ? `<p style="color:var(--success); font-weight:500;">✓ <strong>Local Preference</strong> — This RFQ prioritizes local labour and contractors.</p>` : `<p style="color:var(--border); font-weight:500;">🌐 <strong>Non-Local</strong> — This RFQ is open to suppliers from other areas. <span style="font-size:12px; display:block; margin-top:4px; font-weight:normal; font-style:italic;">Reason: ${escapeHtmlClient(nonLocalReason || 'No reason provided')}</span></p>`}

      ${requiredDocs && requiredDocs.length > 0 ? `
        <div style="margin: 20px 0;">
          <h4>Required Documents:</h4>
          <ul>
            ${requiredDocs.map(doc => `<li>${escapeHtmlClient(doc.name)}${doc.mandatory ? ' <strong style="color:var(--accent);">(Mandatory)</strong>' : ''}${doc.requires_expiry ? ' <span style="color:var(--border); font-size:12px;">— expiry date required</span>' : ''}</li>`).join('')}
          </ul>
        </div>
      ` : '<p style="color:var(--border); font-style:italic;">(No required documents added yet)</p>'}

      <div style="margin-top: 30px; padding: 15px; background: var(--bg-2); border-radius: 4px; text-align:center;">
        <p style="margin:0; font-size:13px; color:var(--border);">Contractors would see a "Your Company Information" form and document upload fields here, followed by a Submit Application button.</p>
      </div>
    </div>
  `;
}

// Shows the read-only public-page preview in a modal, built from whatever's
// currently in the Create RFQ form — nothing is saved or sent.
function previewRFQ() {
  const values = collectRFQFormValues();
  const body = document.getElementById('rfq-preview-body');
  if (!body) return;
  body.innerHTML = buildRFQPreviewCardHtml(values);
  openModal('rfq-preview-modal');
}

// Shared loader behind both continueEditingDraft() and editRFQ() — reads one
// row and repopulates every Create RFQ form field from it. Attachments
// already on the row are left as-is (uploadRFQAttachments() only adds
// newly-picked files) — the existing attachment list isn't shown as
// individually re-removable here, matching how new RFQs are created today.
// Contractor emails are deliberately NOT repopulated: they're never
// persisted on the row (only turned into rfq_invitations at publish time),
// so leaving the field blank means a plain re-save never re-sends/duplicates
// invitations — typing new emails in and saving is exactly how "invite more
// contractors" already works via createNewRFQ().
async function loadRFQIntoCreateForm(rfqId) {
  const { data: row, error } = await client
    .from('rfqs')
    .select('*')
    .eq('id', rfqId)
    .single();
  if (error || !row) throw new Error(error ? error.message : 'RFQ not found');

  document.getElementById('create-rfq-form').reset();
  document.getElementById('required-docs-builder').innerHTML = '';

  document.querySelector('input[name="rfq_name"]').value = row.rfq_name || '';
  document.querySelector('input[name="rfq_project"]').value = row.project_name || '';
  document.querySelector('textarea[name="rfq_description"]').value = row.description || '';
  document.querySelector('input[name="rfq_deadline"]').value = row.deadline || '';
  document.querySelector('input[name="rfq_budget"]').value = row.budget || '';
  document.querySelector('input[name="rfq_location_area"]').value = row.location_area || '';

  const visibilityValue = row.is_public ? 'open' : 'closed';
  const visibilityInput = document.querySelector(`input[name="rfq_visibility"][value="${visibilityValue}"]`);
  if (visibilityInput) visibilityInput.checked = true;
  updateVisibilityHint();

  (row.provinces || []).forEach(p => {
    const cb = document.querySelector(`.rfq-province-checkbox[value="${p}"]`);
    if (cb) cb.checked = true;
  });

  // Populate local preference
  const localPrefValue = row.is_local_preference ? 'local' : 'non-local';
  const localPrefRadio = document.querySelector(`input[name="rfq_local_preference"][value="${localPrefValue}"]`);
  if (localPrefRadio) localPrefRadio.checked = true;
  const reasonInput = document.querySelector('textarea[name="rfq_non_local_reason"]');
  if (reasonInput && row.non_local_reason) {
    reasonInput.value = row.non_local_reason;
  }
  // Update the visibility of the reason field
  setupLocalPreferenceToggle();

  (row.required_documents || []).forEach(doc => {
    // A row saved against one of the 7 standard Supplier Database
    // categories re-renders as a standard row regardless of what name it
    // was saved under (older RFQs may have a custom-typed heading from
    // before the standard picker existed) — re-saving this RFQ then
    // normalizes its heading to match the Supplier Database, same as any
    // newly-added standard row. Anything not linked to a standard
    // category still renders as a plain custom row, unchanged.
    const isStandard = doc.supplier_doc_category && SUPPLIER_DOC_CATEGORIES.some(c => c.category === doc.supplier_doc_category);
    if (isStandard) {
      addStandardDocumentField(doc.supplier_doc_category, { mandatory: !!doc.mandatory, requires_expiry: !!doc.requires_expiry });
      return;
    }
    addDocumentField();
    const rows = document.querySelectorAll('#required-docs-builder .doc-row');
    const docRow = rows[rows.length - 1];
    docRow.querySelector('.doc-field').value = doc.name || '';
    docRow.querySelector('.doc-mandatory-field').checked = !!doc.mandatory;
    docRow.querySelector('.doc-expiry-field').checked = !!doc.requires_expiry;
    const categorySelect = docRow.querySelector('.doc-supplier-category-field');
    if (categorySelect) {
      categorySelect.value = doc.supplier_doc_category || '';
      // Keep the mutual-exclusivity in sync when repopulating, same as the
      // live change handlers in addDocumentField().
      categorySelect.disabled = !!doc.requires_expiry;
    }
  });

  // Reset file upload tracking and display any existing attachments
  rfqFilesToUpload = [];
  displayRFQAttachments(row.id, row.attachments);

  // Store RFQ data for later reference
  currentRFQData = row;

  return row;
}

// Loads a saved draft's fields back into the Create RFQ form so it can be
// finished and either saved again or published. Called from the RFQ
// Console (drafts are listed there alongside every other RFQ — see
// loadRFQConsole()), so this also has to switch to the Create tab itself,
// same as editRFQ() already does for non-draft rows.
async function continueEditingDraft(draftId) {
  try {
    const draft = await loadRFQIntoCreateForm(draftId);

    currentDraftId = draft.id;
    currentEditingIsDraft = true;
    currentEditingIsReleased = false; // a draft is never released by definition
    updateDraftEditingBanner();

    const createTabBtn = Array.from(document.querySelectorAll('.company-tab-btn'))
      .find(btn => (btn.getAttribute('onclick') || '').includes("'create'"));
    switchAdminTab('create', createTabBtn || null);

    document.getElementById('create-rfq-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast('📝 Draft loaded — continue editing below', 'success');
  } catch (err) {
    console.error('❌ Error loading draft:', err);
    showToast('Error: ' + err.message, 'error');
  }
}

// Loads an already-created RFQ (published or not) from the RFQ Console back
// into the Create RFQ form for editing — same form, same Save/Publish
// buttons, which then UPDATE this row instead of inserting a new one. This
// is also how an existing Closed RFQ gets "released" to Open: visibility is
// just one of the fields being edited here, same as any other field.
async function editRFQ(rfqId) {
  try {
    const row = await loadRFQIntoCreateForm(rfqId);

    currentDraftId = row.id;
    currentEditingIsDraft = false;
    currentEditingIsReleased = !!row.is_released;
    updateDraftEditingBanner();

    const createTabBtn = Array.from(document.querySelectorAll('.company-tab-btn'))
      .find(btn => (btn.getAttribute('onclick') || '').includes("'create'"));
    switchAdminTab('create', createTabBtn || null);

    document.getElementById('create-rfq-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast('✏️ RFQ loaded for editing — scroll down to make changes', 'success');
  } catch (err) {
    console.error('❌ Error loading RFQ for editing:', err);
    showToast('Error: ' + err.message, 'error');
  }
}

// Permanently deletes a saved draft (never published, so nothing else
// references it — no invitations, no submissions). If the draft being
// deleted is the one currently loaded in the form, the form resets so
// Publish/Save Draft doesn't try to update a row that no longer exists.
async function deleteDraft(draftId) {
  if (!confirm('Permanently delete this draft? This cannot be undone.')) return;

  try {
    const { error } = await client
      .from('rfqs')
      .delete()
      .eq('id', draftId);
    if (error) throw error;

    if (currentDraftId === draftId) {
      resetCreateForm();
    }

    showToast('🗑️ Draft deleted', 'success');
    loadRFQConsole();
  } catch (err) {
    console.error('❌ Error deleting draft:', err);
    showToast('Error: ' + err.message, 'error');
  }
}

// ===== RFQ CONSOLE =====
// Lists every RFQ for the company, saved drafts included — a draft is just
// an RFQ that hasn't been finalized yet (is_draft: true), so it belongs in
// the same one place Brent manages every other RFQ rather than a separate
// card elsewhere. See "Merge Saved Drafts into the RFQ Console" for why.
async function loadRFQConsole() {
  try {
    if (!currentCompany) return;
    console.log('Loading RFQ Console...');

    const { data: rfqs, error: rfqError } = await client
      .from('rfqs')
      .select('*')
      .eq('company_id', currentCompany.id)
      .order('created_at', { ascending: false });

    if (rfqError || !rfqs || rfqs.length === 0) {
      document.getElementById('rfq-console-list').innerHTML =
        '<div style="text-align: center; padding: 40px; color: var(--border);"><p>No RFQs yet. <strong>Create one to get started!</strong></p></div>';
      return;
    }

    let consoleHtml = '';
    const baseUrl = window.location.origin + window.location.pathname;
    rfqQuestionsById = {};

    for (const rfq of rfqs) {
      // A draft has no invitations/submissions/questions yet (those are
      // only ever created once an RFQ is finalized via Save RFQ/Publish —
      // see saveRFQDraft()), so it gets a short, dedicated card instead of
      // the full one below: no point querying three empty tables per draft.
      if (rfq.is_draft) {
        consoleHtml += `
          <div class="rfq-console-card">
            <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 15px; flex-wrap: wrap; gap: 15px;">
              <div style="flex: 1; min-width: 220px;">
                <h3 style="margin: 0 0 5px 0; color: var(--primary);">
                  ${rfq.rfq_name ? escapeHtmlClient(rfq.rfq_name) : '<span style="font-style:italic; color:var(--border);">(Untitled draft)</span>'}
                  <span class="submission-status info_requested" style="vertical-align:middle; margin-left:8px;">📝 Draft</span>
                </h3>
                ${rfq.project_name ? `<p style="margin: 0 0 8px 0; font-size: 14px; color: var(--border);">Project: <strong>${escapeHtmlClient(rfq.project_name)}</strong></p>` : ''}
                <p style="margin: 0; font-size: 13px; color: var(--border);">Not visible to contractors — no notifications are sent until this is saved and released. Last saved ${new Date(rfq.updated_at || rfq.created_at).toLocaleString()}.</p>
              </div>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
              <button onclick="continueEditingDraft('${rfq.id}')" class="btn secondary" style="padding: 10px;">
                ✏️ Continue Editing
              </button>
              <button onclick="deleteDraft('${rfq.id}')" class="btn" style="padding: 10px; background: var(--bg-2); color: var(--warning);">
                🗑️ Delete Draft
              </button>
            </div>
          </div>
        `;
        continue;
      }

      const { data: invitations } = await client
        .from('rfq_invitations')
        .select('*')
        .eq('rfq_id', rfq.id);

      const { data: submissions } = await client
        .from('rfq_submissions')
        .select('*')
        .eq('rfq_id', rfq.id);

      const { data: questions } = await client
        .from('rfq_questions')
        .select('*')
        .eq('rfq_id', rfq.id)
        .order('created_at', { ascending: false });

      (questions || []).forEach(q => { rfqQuestionsById[q.id] = q; });
      const pendingQuestionCount = (questions || []).filter(q => q.status === 'pending').length;

      const deadlineDate = new Date(rfq.deadline);
      const isExpired = deadlineDate < new Date();
      const daysLeft = Math.ceil((deadlineDate - new Date()) / (1000 * 60 * 60 * 24));
      const submissionCount = submissions ? submissions.length : 0;

      // Calculate invitation count based on RFQ type
      let invitationCount = 0;
      if (rfq.is_public) {
        // For public/broadcast RFQs, use the stored supplier count from when it was published
        invitationCount = rfq.supplier_count_notified || 0;
      } else {
        // For invite-only RFQs, count individual invitations
        invitationCount = invitations ? invitations.length : 0;
      }

      const responseRate = invitationCount > 0 ? Math.round((submissionCount / invitationCount) * 100) : 0;

      consoleHtml += `
        <div class="rfq-console-card ${isExpired ? 'expired' : ''}">
          <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 20px; flex-wrap: wrap; gap: 15px;">
            <div style="flex: 1; min-width: 220px;">
              <h3 style="margin: 0 0 5px 0; color: var(--primary);">
                ${rfq.rfq_name}
                <span class="submission-status ${!rfq.is_released ? 'info_requested' : (rfq.is_withdrawn ? 'rejected' : (rfq.is_public ? 'approved' : 'under_review'))}" style="vertical-align:middle; margin-left:8px;">${!rfq.is_released ? '🕒 Not Released Yet' : (rfq.is_withdrawn ? '🚫 Unpublished' : (rfq.is_public ? 'Open — Public' : 'Closed — Invite Only'))}</span>
              </h3>
              <p style="margin: 0 0 8px 0; font-size: 14px; color: var(--border);">Project: <strong>${rfq.project_name}</strong></p>
              ${(rfq.location_area || (rfq.provinces && rfq.provinces.length > 0)) ? `<p style="margin: 0 0 8px 0; font-size: 14px; color: var(--border);">📍 ${[rfq.location_area, ...(rfq.provinces || [])].filter(Boolean).join(', ')}</p>` : ''}
              ${rfq.is_local_preference ? `<p style="margin: 0 0 8px 0; font-size: 13px; color: var(--success); font-weight: 500;">✓ Local Preference</p>` : `<p style="margin: 0 0 8px 0; font-size: 13px; color: var(--border);">🌐 Non-Local (${rfq.non_local_reason ? 'reason provided' : 'no reason'})</p>`}
              ${!rfq.is_released ? `<p style="margin: 0 0 8px 0; font-size: 13px; color: var(--border);">Saved, not yet public — nothing has been sent to suppliers or contractors. Click <strong>Publish RFQ</strong> below when ready.</p>` : ''}
              ${(rfq.is_public && rfq.notified_provinces && rfq.notified_provinces.length > 0) ? `<p style="margin: 0 0 8px 0; font-size: 13px; color: var(--border);">📢 Suppliers notified in: ${rfq.notified_provinces.map(p => escapeHtmlClient(p)).join(', ')}</p>` : ''}
              <p style="margin: 0; font-size: 14px; color: var(--border);">
                Deadline: ${deadlineDate.toLocaleDateString()}
                <span style="color: ${isExpired ? 'var(--warning)' : 'var(--success)'}; font-weight: bold; margin-left: 8px;">
                  ${isExpired ? '❌ Expired' : `📅 ${daysLeft} days left`}
                </span>
              </p>
            </div>
            <div style="text-align: center; background: var(--bg-2); padding: 12px 16px; border-radius: 4px;">
              <p style="margin: 0; font-size: 11px; text-transform: uppercase; color: var(--border); font-weight: bold;">Response Rate</p>
              <p style="margin: 5px 0 0 0; font-size: 28px; font-weight: bold; color: var(--accent);">${responseRate}%</p>
              <p style="margin: 5px 0 0 0; font-size: 12px; color: var(--border);">${submissionCount}/${invitationCount} responses</p>
            </div>
          </div>

          <div style="background: var(--bg-2); padding: 15px; border-radius: 4px; margin-bottom: 15px;">
            <div style="margin-bottom: 15px;">
              <h4 style="margin: 0 0 8px 0; font-size: 12px; text-transform: uppercase; color: var(--border); font-weight: bold;">Description</h4>
              <p style="margin: 0; color: var(--ink); line-height: 1.5;">${rfq.description}</p>
            </div>

            ${rfq.budget ? `
              <div style="padding-top: 15px; border-top: 1px solid var(--border); margin-top: 15px;">
                <h4 style="margin: 0 0 8px 0; font-size: 12px; text-transform: uppercase; color: var(--border); font-weight: bold;">Budget</h4>
                <p style="margin: 0; color: var(--ink); font-size: 18px; font-weight: bold;">R${rfq.budget.toLocaleString()}</p>
              </div>
            ` : ''}
          </div>

          ${rfq.required_documents && rfq.required_documents.length > 0 ? `
            <div style="background: var(--bg-2); padding: 15px; border-radius: 4px; margin-bottom: 15px;">
              <h4 style="margin: 0 0 10px 0; font-size: 12px; text-transform: uppercase; color: var(--border); font-weight: bold;">Required Documents</h4>
              <ul style="margin: 0; padding-left: 20px; color: var(--ink);">
                ${rfq.required_documents.map(doc => `<li style="margin-bottom: 5px;">${escapeHtmlClient(doc.name)}${doc.mandatory ? ' <strong style="color:var(--accent);">(Mandatory)</strong>' : ''}${doc.requires_expiry ? ' <span style="color:var(--border); font-size:12px;">— expiry date required</span>' : ''}</li>`).join('')}
              </ul>
            </div>
          ` : ''}

          ${rfq.attachments && rfq.attachments.length > 0 ? `
            <div style="background: var(--bg-2); padding: 15px; border-radius: 4px; margin-bottom: 15px;">
              <h4 style="margin: 0 0 10px 0; font-size: 12px; text-transform: uppercase; color: var(--border); font-weight: bold;">RFQ Documents (visible to contractors)</h4>
              <ul style="margin: 0; padding-left: 20px; color: var(--ink);">
                ${rfq.attachments.map(att => `<li style="margin-bottom: 5px;"><a href="${att.url}" target="_blank" rel="noopener noreferrer">${att.name}</a></li>`).join('')}
              </ul>
            </div>
          ` : ''}

          <div style="background: var(--bg-2); padding: 15px; border-radius: 4px; margin-bottom: 15px; max-height: 300px; overflow-y: auto;">
            <h4 style="margin-top: 0; margin-bottom: 10px; color: var(--ink);">Contractor Links (${invitationCount})</h4>
            <div style="display: flex; flex-direction: column; gap: 8px;">
              ${invitations && invitations.length > 0 ? invitations.map((inv, idx) => `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; background: white; border: 1px solid var(--border); border-radius: 3px;">
                  <div style="flex: 1; min-width: 0;">
                    <p style="margin: 0 0 4px 0; font-size: 13px; font-weight: bold; color: var(--ink);">${idx + 1}. ${inv.contractor_email}</p>
                    <code style="font-size: 11px; color: var(--border); display: block; word-break: break-all; font-family: var(--mono);">${baseUrl}?rfq=${inv.invitation_token}</code>
                    <p style="margin: 4px 0 0 0; font-size: 11px; color: var(--border);">${inv.used ? '✅ Submitted' : '⏳ Pending'}</p>
                  </div>
                  <button onclick="copyToClipboard('${baseUrl}?rfq=${inv.invitation_token}')"
                    class="btn" style="margin-left: 10px; padding: 6px 10px; font-size: 12px; white-space: nowrap; flex-shrink: 0;">
                    Copy
                  </button>
                </div>
              `).join('') : '<p style="margin: 0; color: var(--border); font-style: italic;">No invitations sent yet</p>'}
            </div>
          </div>

          <div style="background: var(--bg-2); padding: 15px; border-radius: 4px; margin-bottom: 15px; max-height: 320px; overflow-y: auto;">
            <h4 style="margin-top: 0; margin-bottom: 10px; color: var(--ink);">Questions ${pendingQuestionCount > 0 ? `<span class="submission-status info_requested" style="vertical-align:middle; margin-left:6px;">${pendingQuestionCount} pending</span>` : `(${(questions || []).length})`}</h4>
            <div style="display: flex; flex-direction: column; gap: 8px;">
              ${questions && questions.length > 0 ? questions.map(q => `
                <div style="padding: 10px; background: white; border: 1px solid var(--border); border-radius: 3px;">
                  <p style="margin: 0 0 6px 0; font-size: 13px; font-weight: bold; color: var(--ink);">${escapeHtmlClient(q.question)}</p>
                  <p style="margin: 0 0 8px 0; font-size: 11px; color: var(--border);">From ${escapeHtmlClient(q.applicant_name || q.applicant_email)} · ${new Date(q.created_at).toLocaleDateString()}</p>
                  ${q.status === 'answered' ? `
                    <div style="background: var(--bg-2); border-radius: 3px; padding: 8px; margin-bottom: 6px;">
                      <p style="margin: 0; font-size: 13px; color: var(--ink); white-space:pre-wrap;">${escapeHtmlClient(q.answer)}</p>
                    </div>
                    <p style="margin: 0; font-size: 11px; color: var(--border);">${q.answer_visibility === 'public' ? '🌐 Posted publicly' : '✉️ Sent privately'} · answered ${q.answered_at ? new Date(q.answered_at).toLocaleDateString() : ''}</p>
                  ` : `
                    <button onclick="openAnswerQuestionModal('${q.id}')" class="btn gold" style="padding: 6px 12px; font-size: 12px;">Reply</button>
                  `}
                </div>
              `).join('') : '<p style="margin: 0; color: var(--border); font-style: italic;">No questions yet</p>'}
            </div>
          </div>

          <div style="display: grid; grid-template-columns: ${rfq.is_released ? '1fr' : '1fr 1fr'}; gap: 10px; margin-bottom: 10px;">
            <button onclick="editRFQ('${rfq.id}')" class="btn secondary" style="padding: 10px;">
              ✏️ Edit RFQ
            </button>
            ${!rfq.is_released ? `
              <button onclick="releaseRFQ('${rfq.id}')" class="btn gold" style="padding: 10px;">
                🚀 Publish RFQ
              </button>
            ` : ''}
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
            <button onclick="showAddContractorForm('${rfq.id}')" class="btn secondary" style="padding: 10px;">
              + Add Contractor
            </button>
            <button onclick="copyAllRFQLinks('${rfq.id}')" class="btn gold" style="padding: 10px;">
              Copy All Links
            </button>
          </div>

          ${(rfq.is_public && rfq.is_released) ? `
            <div style="display: grid; grid-template-columns: ${rfq.is_withdrawn ? '1fr' : '1fr 1fr'}; gap: 10px; margin-top: 10px;">
              ${rfq.is_withdrawn ? `
                <button onclick="republishRFQ('${rfq.id}')" class="btn gold" style="padding: 10px;">
                  🔓 Republish
                </button>
              ` : `
                <button onclick='openExpandSearchModal("${rfq.id}", ${JSON.stringify(JSON.stringify(rfq.notified_provinces || []))})' class="btn secondary" style="padding: 10px;">
                  📢 Expand Supplier Search
                </button>
                <button onclick="unpublishRFQ('${rfq.id}')" class="btn" style="padding: 10px; background: var(--bg-2); color: var(--warning);">
                  🚫 Unpublish
                </button>
              `}
            </div>
          ` : ''}
        </div>
      `;
    }

    document.getElementById('rfq-console-list').innerHTML = consoleHtml;

  } catch (err) {
    console.error('Error in loadRFQConsole:', err);
    showToast('Error: ' + err.message, 'error');
  }
}

// ===== SUBMISSIONS =====
async function loadSubmissions() {
  try {
    if (!currentCompany) return;
    console.log('Loading submissions...');

    // Only informational — a restricted (non-owner, explicitly-permissioned)
    // team member's list below is already narrowed by the DB itself (the
    // rfq_submissions SELECT policy hides any stage they don't have "view"
    // access to), so this just explains why the list may look shorter than
    // expected rather than looking like a bug.
    const limitedNote = document.getElementById('submissions-limited-access-note');
    if (limitedNote) {
      limitedNote.style.display = (currentMemberRole !== 'owner' && currentMemberPermissions !== null && currentMemberPermissions !== undefined) ? 'block' : 'none';
    }

    const { data: allSubmissions, error } = await client
      .from('rfq_submissions')
      .select(`*, rfqs!inner(rfq_name, company_id)`)
      .eq('rfqs.company_id', currentCompany.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    console.log('Submissions loaded:', allSubmissions ? allSubmissions.length : 0);

    // Flag any submission that has at least one document whose expiry date
    // had already passed by the time it was submitted, so staff can spot
    // problem submissions from the list without opening every one.
    const submissionIds = (allSubmissions || []).map(s => s.id);
    const expiredSubmissionIds = new Set();
    if (submissionIds.length > 0) {
      const { data: docsWithExpiry } = await client
        .from('rfq_submission_documents')
        .select('submission_id, expiry_date')
        .in('submission_id', submissionIds)
        .not('expiry_date', 'is', null);

      const createdAtById = new Map((allSubmissions || []).map(s => [s.id, s.created_at]));
      (docsWithExpiry || []).forEach(doc => {
        const submittedAt = createdAtById.get(doc.submission_id);
        if (submittedAt && new Date(doc.expiry_date) < new Date(submittedAt)) {
          expiredSubmissionIds.add(doc.submission_id);
        }
      });
    }

    // Populate the RFQ filter's options from the full (unfiltered) set so the
    // dropdown always lists every RFQ that has submissions, regardless of the
    // currently-selected filters — rebuilding it from an already-filtered
    // list would make other RFQs disappear from the dropdown itself.
    const rfqFilterEl = document.getElementById('rfq-filter');
    if (rfqFilterEl) {
      const previousSelection = rfqFilterEl.value;
      const rfqOptionsById = new Map();
      (allSubmissions || []).forEach(sub => {
        if (sub.rfq_id && !rfqOptionsById.has(sub.rfq_id)) {
          rfqOptionsById.set(sub.rfq_id, sub.rfqs ? sub.rfqs.rfq_name : sub.rfq_id);
        }
      });
      rfqFilterEl.innerHTML = '<option value="">All RFQs</option>' +
        Array.from(rfqOptionsById.entries()).map(([id, name]) => `<option value="${id}">${name}</option>`).join('');
      rfqFilterEl.value = previousSelection && rfqOptionsById.has(previousSelection) ? previousSelection : '';
    }

    // Disable (don't remove — keeps "All Statuses" behavior intact) any
    // status-filter option this team member has no view access to, so they
    // can't pick a filter that would always show "no submissions match this
    // filter" for a stage they're not permitted to see at all.
    const statusFilterEl = document.getElementById('status-filter');
    if (statusFilterEl) {
      Array.from(statusFilterEl.options).forEach(opt => {
        if (!opt.value) return; // "All Statuses"
        opt.disabled = !canViewSubmissionStage(opt.value);
      });
      if (statusFilterEl.selectedOptions[0] && statusFilterEl.selectedOptions[0].disabled) {
        statusFilterEl.value = '';
      }
    }

    const rfqFilterValue = rfqFilterEl ? rfqFilterEl.value : '';
    const statusFilterValue = document.getElementById('status-filter') ? document.getElementById('status-filter').value : '';

    const submissions = (allSubmissions || []).filter(sub => {
      if (rfqFilterValue && sub.rfq_id !== rfqFilterValue) return false;
      if (statusFilterValue && sub.status !== statusFilterValue) return false;
      return true;
    });

    if (submissions.length === 0) {
      document.getElementById('submissions-list').innerHTML = `<p style="text-align: center; color: var(--border); padding: 40px;">${(allSubmissions || []).length === 0 ? 'No submissions yet' : 'No submissions match this filter'}</p>`;
      return;
    }

    const listHtml = submissions.map(sub => `
      <div class="submission-card" onclick="openSubmissionDetail('${sub.id}')">
        <h3 style="margin: 0 0 10px 0; color: var(--ink);">${sub.contractor_name}${expiredSubmissionIds.has(sub.id) ? ' <span title="Contains a document that was already expired at submission" style="color:var(--closing-today, #D8452B); font-size:14px; font-weight:bold;">🚩 Expired document</span>' : ''}</h3>
        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px; margin-bottom: 15px; font-size: 14px;">
          <div>
            <p style="margin: 0; color: var(--border);">Email: <strong>${sub.contractor_email}</strong></p>
          </div>
          <div>
            <p style="margin: 0; color: var(--border);">RFQ: <strong>${sub.rfqs.rfq_name}</strong></p>
          </div>
          <div>
            <p style="margin: 0; color: var(--border);">Submitted: ${new Date(sub.created_at).toLocaleDateString()}</p>
          </div>
        </div>
        <div class="submission-status ${sub.status}">${sub.status}</div>
      </div>
    `).join('');

    document.getElementById('submissions-list').innerHTML = listHtml;

  } catch (err) {
    console.error('Error in loadSubmissions:', err);
    showToast('Error loading submissions: ' + err.message, 'error');
  }
}

async function openSubmissionDetail(id) {
  try {
    const { data: submission } = await client
      .from('rfq_submissions')
      .select('*')
      .eq('id', id)
      .single();

    const { data: rfq } = await client
      .from('rfqs')
      .select('*')
      .eq('id', submission.rfq_id)
      .single();

    const { data: documents } = await client
      .from('rfq_submission_documents')
      .select('*')
      .eq('submission_id', id);

    let detailsHtml = `
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 20px;">
        <div>
          <label style="font-weight: bold; font-size: 12px; text-transform: uppercase; color: var(--ink);">Company Name</label>
          <p style="margin: 5px 0; font-size: 16px; color: var(--ink);">${submission.contractor_name}</p>
        </div>
        <div>
          <label style="font-weight: bold; font-size: 12px; text-transform: uppercase; color: var(--ink);">Email</label>
          <p style="margin: 5px 0; font-size: 16px; color: var(--ink);">${submission.contractor_email}</p>
        </div>
        <div>
          <label style="font-weight: bold; font-size: 12px; text-transform: uppercase; color: var(--ink);">Phone</label>
          <p style="margin: 5px 0; font-size: 16px; color: var(--ink);">${submission.contractor_phone}</p>
        </div>
        <div>
          <label style="font-weight: bold; font-size: 12px; text-transform: uppercase; color: var(--ink);">Reg Number</label>
          <p style="margin: 5px 0; font-size: 16px; color: var(--ink);">${submission.contractor_reg}</p>
        </div>
      </div>

      ${rfq ? `
        <div style="background: var(--bg-2); padding: 15px; border-radius: 4px; margin-bottom: 20px;">
          <h4 style="margin: 0 0 10px 0; color: var(--ink);">RFQ: ${rfq.rfq_name}</h4>
          <p style="margin: 5px 0; font-size: 14px; color: var(--border);">Project: ${rfq.project_name}</p>
          <p style="margin: 5px 0; font-size: 14px; color: var(--border);">Deadline: ${new Date(rfq.deadline).toLocaleDateString()}</p>
        </div>
      ` : ''}

      <div>
        <label style="font-weight: bold; font-size: 12px; text-transform: uppercase; color: var(--ink);">Submitted</label>
        <p style="margin: 5px 0; font-size: 14px; color: var(--border);">${new Date(submission.created_at).toLocaleString()}</p>
      </div>
    `;

    const docsHtml = documents && documents.length > 0
      ? documents.map(doc => {
          // "Expired" here means the document's own expiry date had already
          // passed by the time it was submitted — not that it has since
          // expired — since that's the compliance check that matters (did
          // the contractor submit a document that was already out of date).
          const isExpired = !!(doc.expiry_date && submission.created_at && new Date(doc.expiry_date) < new Date(submission.created_at));
          return `
          <div style="padding: 8px; border: 1px solid ${isExpired ? 'var(--closing-today, #D8452B)' : 'var(--border)'}; border-radius: 4px; margin-bottom: 8px;${isExpired ? ' background:#FDECEA;' : ''}">
            <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px;">
              <span style="color: var(--ink);">📄 ${escapeHtmlClient(doc.file_name)}</span>
              <button onclick="downloadDocument('${doc.file_path}', '${doc.file_name}')"
                class="btn" style="padding: 4px 12px; font-size: 12px; flex-shrink:0;">
                Download
              </button>
            </div>
            ${doc.document_type ? `<p style="margin:6px 0 0 0; font-size:12px; color:var(--border);">Type: ${escapeHtmlClient(doc.document_type)}</p>` : ''}
            ${doc.reused_from_supplier_profile ? `<p style="margin:2px 0 0 0; font-size:12px; color:var(--border);">↩️ Reused from Supplier Database</p>` : ''}
            ${doc.expiry_date ? `<p style="margin:2px 0 0 0; font-size:12px; ${isExpired ? 'color:var(--closing-today, #D8452B); font-weight:bold;' : 'color:var(--border);'}">
              Expiry: ${new Date(doc.expiry_date).toLocaleDateString()}${isExpired ? ' — 🚩 Already expired at time of submission' : ''}
            </p>` : ''}
          </div>
        `;
        }).join('')
      : '<p style="color: var(--border); font-style: italic;">No documents submitted</p>';

    const detailsContent = document.getElementById('submission-details-content');
    const docsContent = document.getElementById('submission-documents-list');

    if (detailsContent) detailsContent.innerHTML = detailsHtml;
    if (docsContent) docsContent.innerHTML = docsHtml;

    const requestBox = document.getElementById('submission-info-request-box');
    if (requestBox) {
      if (submission.info_request_message) {
        requestBox.style.display = 'block';
        document.getElementById('submission-info-request-text').textContent = submission.info_request_message;
        document.getElementById('submission-info-request-date').textContent = submission.info_requested_at
          ? `Requested ${new Date(submission.info_requested_at).toLocaleString()}`
          : '';
      } else {
        requestBox.style.display = 'none';
      }
    }

    const responseBox = document.getElementById('submission-info-response-box');
    if (responseBox) {
      if (submission.info_response_message) {
        responseBox.style.display = 'block';
        document.getElementById('submission-info-response-text').textContent = submission.info_response_message;
        document.getElementById('submission-info-response-date').textContent = submission.info_response_at
          ? `Received ${new Date(submission.info_response_at).toLocaleString()}`
          : '';
      } else {
        responseBox.style.display = 'none';
      }
    }

    const statusSelect = document.getElementById('submission-status-update');
    if (statusSelect) {
      statusSelect.value = submission.status;
      statusSelect.dataset.submissionId = id;
    }
    const messageBox = document.getElementById('submission-info-request-message');
    if (messageBox) messageBox.value = '';
    applySubmissionStagePermissionsToStatusSelect();
    onSubmissionStatusSelectChange();

    const title = document.getElementById('submission-title');
    if (title) title.textContent = submission.contractor_name;

    openModal('submission-detail-modal');

  } catch (err) {
    console.error('Error opening submission detail:', err);
    showToast('Error: ' + err.message, 'error');
  }
}

// Toggles the "what do you need?" message box and relabels the action
// button based on which status is currently selected — Request More
// Information needs a message + triggers an email, everything else is a
// plain status write.
function onSubmissionStatusSelectChange() {
  const statusSelect = document.getElementById('submission-status-update');
  const formBox = document.getElementById('submission-info-request-form');
  const actionBtn = document.getElementById('submission-status-action-btn');
  if (!statusSelect || !formBox || !actionBtn) return;

  const isInfoRequest = statusSelect.value === 'info_requested';
  formBox.style.display = isInfoRequest ? 'block' : 'none';
  actionBtn.textContent = isInfoRequest ? 'Send Request' : 'Update Status';
}

// Disables any status option this team member doesn't have "edit" access to
// (per SUBMISSION_STAGES / company_members.permissions), so the dropdown
// only ever lets them pick a stage they're actually allowed to move a
// submission into. If they have edit access to nothing at all, the whole
// control is disabled with an explanatory note. This is UX only — the real
// enforcement is the rfq_submissions UPDATE policy's
// can_act_on_submission_status(..., 'edit') check, which blocks the write
// server-side regardless of what the dropdown lets them click.
function applySubmissionStagePermissionsToStatusSelect() {
  const statusSelect = document.getElementById('submission-status-update');
  const actionBtn = document.getElementById('submission-status-action-btn');
  const noAccessNote = document.getElementById('submission-status-no-access-note');
  if (!statusSelect) return;

  let anyEditable = false;
  Array.from(statusSelect.options).forEach(opt => {
    const editable = canEditSubmissionStage(opt.value);
    opt.disabled = !editable;
    if (editable) anyEditable = true;
  });

  statusSelect.disabled = !anyEditable;
  if (actionBtn) actionBtn.disabled = !anyEditable;
  if (noAccessNote) noAccessNote.style.display = anyEditable ? 'none' : 'block';
}

async function handleSubmissionStatusAction() {
  const statusSelect = document.getElementById('submission-status-update');
  if (!statusSelect || !statusSelect.dataset.submissionId) {
    showToast('Error: submission ID not found', 'error');
    return;
  }

  const id = statusSelect.dataset.submissionId;
  const newStatus = statusSelect.value;

  if (newStatus === 'info_requested') {
    await sendSubmissionInfoRequest(id);
    return;
  }

  try {
    const { error } = await client
      .from('rfq_submissions')
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', id);

    if (error) throw error;

    showToast('✅ Status updated!', 'success');
    closeModal('submission-detail-modal');
    loadSubmissions();

  } catch (err) {
    console.error('Error:', err);
    showToast('Error: ' + err.message, 'error');
  }
}

// Emails the contractor asking for more information/documents via the
// request-submission-info Edge Function (Resend) — mirrors the pattern used
// for send-rfq-invites. The submission's status flips to 'info_requested'
// server-side once the email is queued.
async function sendSubmissionInfoRequest(submissionId) {
  const messageBox = document.getElementById('submission-info-request-message');
  const message = messageBox ? messageBox.value.trim() : '';

  if (!message) {
    showToast('Please describe what information you need', 'error');
    return;
  }

  try {
    showToast('Sending request...', 'info');
    await callEdgeFunction('request-submission-info', { submissionId, message });
    showToast('✅ Information request emailed to the contractor', 'success');
    closeModal('submission-detail-modal');
    loadSubmissions();
  } catch (err) {
    console.error('Error sending info request:', err);
    showToast('Error: ' + err.message, 'error');
  }
}

function filterSubmissions() {
  loadSubmissions();
}

// Per-team-member permission helpers for the Review Submissions stages
// (Submitted / Under Review / Request More Information / Response Received /
// Approved / Rejected). The company owner always has full access regardless
// of currentMemberPermissions; a non-owner with currentMemberPermissions
// still null (never restricted by the owner) also gets full access — that's
// the "full access until restricted" default. Once the owner has saved an
// explicit permissions object for someone, only what's actually set to true
// in it applies. This client-side check is UX only (which options/rows show);
// the real enforcement is the RLS policies that call
// can_act_on_submission_status() directly — see the project notes.
function canViewSubmissionStage(status) {
  if (currentMemberRole === 'owner') return true;
  if (currentMemberPermissions === null || currentMemberPermissions === undefined) return true;
  const perm = currentMemberPermissions[status];
  return !!(perm && perm.view);
}
function canEditSubmissionStage(status) {
  if (currentMemberRole === 'owner') return true;
  if (currentMemberPermissions === null || currentMemberPermissions === undefined) return true;
  const perm = currentMemberPermissions[status];
  return !!(perm && perm.edit);
}

// ===== SUPER ADMIN =====
// Permission helpers: the admin-manager (owner, super_admins.can_manage_admins)
// always has full access regardless of the permissions column — same bypass
// the DB-layer has_admin_permission() function applies. This client-side
// check is UX only; the real enforcement is the RLS policies/Edge Functions
// that call has_admin_permission() directly (see the Edit Supplier /
// Manage Admins-era RLS gotchas documented in the project notes).
function canViewSection(section) {
  if (isAdminManager) return true;
  const perm = currentAdminPermissions && currentAdminPermissions[section];
  return !!(perm && (perm.view || perm.edit));
}
function canEditSection(section) {
  if (isAdminManager) return true;
  const perm = currentAdminPermissions && currentAdminPermissions[section];
  return !!(perm && perm.edit);
}

// Shows/hides each of the 4 gate-able Super Admin sidebar tabs + disables
// their write controls based on currentAdminPermissions, then makes sure
// the currently-open tab is one this admin can actually see (falling back
// to the first visible tab, or a "no access" message if there are none).
function applySuperAdminPermissionsToUI() {
  const SECTION_TABS = {
    invite_company: 'super-invite',
    platform_branding: 'super-branding',
    companies: 'super-companies',
    applicants: 'super-applicants',
    billing: 'super-subscriptions'
  };

  Object.entries(SECTION_TABS).forEach(([section, tabId]) => {
    const btn = document.getElementById(tabId + '-tab-btn');
    if (btn) btn.style.display = canViewSection(section) ? '' : 'none';
  });

  // Invite a Company: disable the form itself when view-only.
  const inviteEditable = canEditSection('invite_company');
  ['invite-company-name', 'invite-company-email', 'invite-company-submit-btn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !inviteEditable;
  });
  const inviteNote = document.getElementById('invite-company-readonly-note');
  if (inviteNote) inviteNote.style.display = (canViewSection('invite_company') && !inviteEditable) ? 'block' : 'none';

  // Platform Branding: disable the upload input + size slider when view-only.
  const brandingEditable = canEditSection('platform_branding');
  ['platform-logo-file', 'platform-logo-scale'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !brandingEditable;
  });
  const brandingNote = document.getElementById('platform-branding-readonly-note');
  if (brandingNote) brandingNote.style.display = (canViewSection('platform_branding') && !brandingEditable) ? 'block' : 'none';

  // Supplier Database: the Import Suppliers button is a write action.
  const importBtn = document.getElementById('import-suppliers-btn');
  if (importBtn) importBtn.style.display = canEditSection('applicants') ? '' : 'none';

  // If the tab that's about to be shown (first tab, per showSuperAdminView's
  // reset-to-first-tab behavior) isn't one this admin can view, jump to the
  // first section they *can* see instead — Manage Admins (owner-only,
  // handled separately) and Change Password are never section-gated.
  const firstVisibleSection = Object.entries(SECTION_TABS).find(([section]) => canViewSection(section));
  document.querySelectorAll('.super-tab').forEach(tab => tab.style.display = 'none');
  document.querySelectorAll('.super-tab-btn').forEach(btn => btn.classList.remove('active'));
  if (firstVisibleSection) {
    const [, tabId] = firstVisibleSection;
    document.getElementById(tabId + '-tab').style.display = 'block';
    const btn = document.getElementById(tabId + '-tab-btn');
    if (btn) btn.classList.add('active');
  } else {
    // No section access at all yet — land on Change Password rather than a blank page.
    document.getElementById('super-password-tab').style.display = 'block';
    const pwBtn = document.querySelector('.super-tab-btn[onclick*="super-password"]');
    if (pwBtn) pwBtn.classList.add('active');
  }
}

function openSuperAdminView() {
  if (!isSuperAdmin) {
    showToast('Not authorized', 'error');
    return;
  }
  showSuperAdminView();
}

// ----- Admin permission grid helpers (shared by the Invite Admin form's
// grid and the Edit Permissions modal's grid, distinguished by idPrefix
// "invite-perm" / "edit-perm") -----

// "Edit" implies "View": checking Edit auto-checks View, and unchecking
// View auto-unchecks Edit, so the two checkboxes can never end up in an
// inconsistent state (matches how canViewSection() already treats edit:true
// as also granting view).
function wirePermissionCheckboxes(idPrefix) {
  ADMIN_PERMISSION_SECTIONS.forEach(section => {
    const viewBox = document.getElementById(`${idPrefix}-${section}-view`);
    const editBox = document.getElementById(`${idPrefix}-${section}-edit`);
    if (!viewBox || !editBox || viewBox.dataset.wired) return;
    editBox.addEventListener('change', () => { if (editBox.checked) viewBox.checked = true; });
    viewBox.addEventListener('change', () => { if (!viewBox.checked) editBox.checked = false; });
    viewBox.dataset.wired = 'true';
  });
}

function collectPermissionsFromGrid(idPrefix) {
  const permissions = {};
  ADMIN_PERMISSION_SECTIONS.forEach(section => {
    const viewBox = document.getElementById(`${idPrefix}-${section}-view`);
    const editBox = document.getElementById(`${idPrefix}-${section}-edit`);
    const edit = !!(editBox && editBox.checked);
    permissions[section] = { view: !!(viewBox && viewBox.checked) || edit, edit };
  });
  return permissions;
}

function setPermissionsGrid(idPrefix, permissions) {
  ADMIN_PERMISSION_SECTIONS.forEach(section => {
    const perm = (permissions && permissions[section]) || {};
    const viewBox = document.getElementById(`${idPrefix}-${section}-view`);
    const editBox = document.getElementById(`${idPrefix}-${section}-edit`);
    if (viewBox) viewBox.checked = !!(perm.view || perm.edit);
    if (editBox) editBox.checked = !!perm.edit;
  });
}

let pendingAdminPermissionsEmail = null;
function openAdminPermissionsModal(email) {
  pendingAdminPermissionsEmail = email;
  const admin = lastLoadedSuperAdmins.find(a => a.email === email);
  const label = document.getElementById('edit-perm-target-label');
  if (label) label.textContent = `Setting permissions for ${email}`;
  setPermissionsGrid('edit-perm', (admin && admin.permissions) || {});
  openModal('admin-permissions-modal');
}

async function handleSaveAdminPermissions() {
  if (!pendingAdminPermissionsEmail) return;
  const permissions = collectPermissionsFromGrid('edit-perm');
  try {
    const { error } = await client
      .from('super_admins')
      .update({ permissions })
      .eq('email', pendingAdminPermissionsEmail);
    if (error) throw error;
    showToast(`✅ Updated permissions for ${pendingAdminPermissionsEmail}`, 'success');
    closeModal('admin-permissions-modal');
    loadSuperAdminsList();
  } catch (err) {
    console.error('Error saving admin permissions:', err);
    showToast('❌ Error: ' + err.message, 'error');
  }
}

function showSuperAdminView() {
  hideAllTopLevelViews();
  document.getElementById('super-admin-view').style.display = 'block';
  applyDefaultBranding();
  document.getElementById('brand-title').textContent = 'RFQ Hub — Platform Admin';

  // Only offer "Back to Dashboard" if there's actually a company dashboard to go back to.
  const backLink = document.getElementById('back-to-dashboard-link');
  if (backLink) backLink.style.display = currentCompany ? 'inline-block' : 'none';

  renderPlatformLogoPreview();
  // Companies data is public anyway (see companies_select_public RLS), so
  // loading it is harmless even if this admin can't view the tab; the
  // Supplier Database is genuinely permission-gated at the RLS layer, so
  // only fetch it if this admin actually has view access — otherwise the
  // query would just come back empty and print a confusing "no one has
  // registered" message behind a tab that's hidden anyway.
  loadSuperAdminCompanies();
  loadSuperAdminRFQs();
  loadNotificationSubscribers();
  if (canViewSection('applicants')) loadSuperAdminApplicants();

  // "Manage Admins" is only usable by the admin-manager (see
  // isAdminManager) — hidden entirely for any other super admin. Unlike
  // the 4 permission-gated sections above, this one is never grantable —
  // only the owner can invite/remove admins or change their permissions.
  const manageAdminsBtn = document.getElementById('super-manage-admins-tab-btn');
  if (manageAdminsBtn) manageAdminsBtn.style.display = isAdminManager ? '' : 'none';
  if (isAdminManager) loadSuperAdminsList();

  // Hide/show each gate-able tab per this admin's permissions and land on
  // the first one they can actually see (see applySuperAdminPermissionsToUI).
  applySuperAdminPermissionsToUI();
}

function closeSuperAdminView() {
  if (!currentCompany) {
    showToast("You're not a member of any company yet — invite one above to get started.", 'info');
    return;
  }
  showAdminView();
}

async function loadSuperAdminCompanies() {
  try {
    const { data: companies, error } = await client
      .from('companies')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const list = document.getElementById('super-admin-companies-list');
    if (!companies || companies.length === 0) {
      list.innerHTML = '<p style="color:var(--border); text-align:center; padding:20px;">No companies yet.</p>';
      return;
    }

    list.innerHTML = companies.map(c => `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:15px; border:1px solid var(--border); border-radius:4px; margin-bottom:10px; flex-wrap:wrap; gap:10px;">
        <div style="display:flex; align-items:center; gap:12px;">
          ${c.logo_url ? `<img src="${c.logo_url}" style="width:36px; height:36px; object-fit:contain; border-radius:6px;">` : ''}
          <div>
            <p style="margin:0; font-weight:600;">${c.name}</p>
            <p style="margin:0; font-size:12px; color:var(--border);">${c.contact_email || 'No contact email'} · Joined ${new Date(c.created_at).toLocaleDateString()}</p>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:10px;">
          <span class="submission-status ${c.status === 'active' ? 'approved' : 'rejected'}">${c.status}</span>
          ${canEditSection('companies') ? `
            <button onclick="toggleCompanyStatus('${c.id}', '${c.status}')" class="btn secondary" style="padding:6px 12px; font-size:12px;">
              ${c.status === 'active' ? 'Suspend' : 'Reactivate'}
            </button>
            <button onclick="deleteCompany('${c.id}', '${(c.name || '').replace(/'/g, "\\'")}')" class="btn secondary" style="padding:6px 12px; font-size:12px; color:#D32F2F; border-color:#D32F2F;">
              Delete
            </button>
          ` : ''}
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Error loading companies:', err);
    showToast('Error loading companies: ' + err.message, 'error');
  }
}

// "Removed" suppliers are hidden from the default Supplier Database list
// (reversible removal, not a hard delete — see suspendSupplier/
// removeSupplier below) — this toggles whether the list also shows them.
let showRemovedSuppliers = false;

// Full, unfiltered list fetched from the DB, cached here so the search box
// and the two filter dropdowns can re-render instantly from memory on
// every keystroke/change instead of re-querying the database each time.
let allSupplierApplicants = [];

function toggleShowRemovedSuppliers() {
  showRemovedSuppliers = !showRemovedSuppliers;
  renderSupplierList();
}

// Re-renders the Supplier Database list from the already-fetched
// allSupplierApplicants cache, applying the search box + province/status
// filters. Called on every keystroke/change in those controls, and after
// loadSuperAdminApplicants() re-fetches from the DB.
function filterSupplierDatabase() {
  renderSupplierList();
}

function renderSupplierList() {
  const list = document.getElementById('super-admin-applicants-list');
  if (!list) return;

  const allApplicants = allSupplierApplicants;
  const removedCount = allApplicants.filter(a => a.status === 'removed').length;

  const searchInput = document.getElementById('supplier-search-input');
  const provinceFilter = document.getElementById('supplier-province-filter');
  const statusFilter = document.getElementById('supplier-status-filter');
  const searchTerm = (searchInput ? searchInput.value : '').trim().toLowerCase();
  const provinceValue = provinceFilter ? provinceFilter.value : '';
  const statusValue = statusFilter ? statusFilter.value : '';

  let visibleApplicants = allApplicants.filter(a => {
    // An explicit "Removed" status filter always wins over the show/hide
    // toggle below; otherwise the toggle keeps its existing behavior of
    // hiding removed suppliers from the default view.
    if (statusValue) {
      if (a.status !== statusValue) return false;
    } else if (a.status === 'removed' && !showRemovedSuppliers) {
      return false;
    }
    if (provinceValue && a.province !== provinceValue) return false;
    if (searchTerm) {
      const haystack = [a.company_name, a.full_name, a.email, a.phone, a.additional_phone, a.supplier_number]
        .filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(searchTerm)) return false;
    }
    return true;
  });

  const toggleHtml = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:10px;">
      <p style="color:var(--border); font-size:13px; margin:0;">${visibleApplicants.length} supplier${visibleApplicants.length === 1 ? '' : 's'} shown</p>
      ${removedCount > 0 ? `<button type="button" class="btn secondary" style="padding:6px 12px; font-size:12px;" onclick="toggleShowRemovedSuppliers()">${showRemovedSuppliers ? 'Hide' : 'Show'} Removed (${removedCount})</button>` : ''}
    </div>
  `;

  if (allApplicants.length === 0) {
    list.innerHTML = '<p style="color:var(--border); text-align:center; padding:20px;">No one has registered yet.</p>';
    return;
  }
  if (visibleApplicants.length === 0) {
    list.innerHTML = toggleHtml + '<p style="color:var(--border); text-align:center; padding:20px;">No suppliers match your search/filters.</p>';
    return;
  }

  // The 3 documents an admin can upload/replace directly (see
  // uploadOrReplaceSupplierDocument below) — kept separate from the
  // remaining optional documents below, which stay download-only.
  // keyPrefix must match SUPPLIER_DOC_CATEGORIES' keyPrefix for the same
  // category (see comment there) — it's a short tag embedded in the
  // storage object key, NOT the DB column name, so that
  // get_my_documents()/get_my_supplier_documents() can strip it back off
  // to recover the original filename for the self-service prefs page.
  const MANAGED_DOC_FIELDS = [
    ['cipc_document_path', 'CIPC/ID', 'cipc'],
    ['proof_of_address_document_path', 'Proof of Address', 'proof-of-address'],
    ['sars_document_path', 'SARS Info', 'sars']
  ];

  const managedDocButtons = (a) => MANAGED_DOC_FIELDS.map(([col, label, keyPrefix]) => {
    const path = a[col];
    const canEditApplicants = canEditSection('applicants');
    if (path) {
      return `
        <span style="display:inline-flex; gap:4px;">
          <button type="button" class="btn secondary" style="padding:6px 10px; font-size:12px;" onclick="downloadSupplierDocument('${path}', '${label.replace(/'/g, "\\'")}')">📄 ${label}</button>
          ${canEditApplicants ? `<button type="button" class="btn secondary" style="padding:6px 10px; font-size:12px;" onclick="uploadOrReplaceSupplierDocument('${a.id}', '${col}', '${keyPrefix}', '${label.replace(/'/g, "\\'")}')">🔄 Replace</button>` : ''}
        </span>
      `;
    }
    if (!canEditApplicants) return '';
    return `<button type="button" class="btn secondary" style="padding:6px 10px; font-size:12px; border-color:var(--warning); color:var(--warning);" onclick="uploadOrReplaceSupplierDocument('${a.id}', '${col}', '${keyPrefix}', '${label.replace(/'/g, "\\'")}')">⬆️ Upload ${label}</button>`;
  }).join('');

  // Remaining optional documents stay download-only, same as before.
  const otherDocFields = (a) => {
    const fields = [
      ['Proof of Banking', a.proof_of_banking_document_path],
      ['B-BBEE', a.bbbee_document_path],
      ['Health & Safety', a.health_safety_document_path],
      ['Special Permits', a.special_permits_document_path]
    ].filter(([, path]) => !!path);
    (a.other_documents || []).forEach(doc => fields.push([doc.name || 'Other Document', doc.path]));
    return fields;
  };

  const statusBadge = (a) => {
    if (a.status === 'suspended') return '<span class="submission-status info_requested">Suspended</span>';
    if (a.status === 'removed') return '<span class="submission-status rejected">Removed</span>';
    return '<span class="submission-status approved">Active</span>';
  };

  // Shown regardless of status: flags a row missing any of the 3
  // mandatory documents (always true right after a bulk import, since
  // documents aren't part of that flow — see openImportSuppliersModal)
  // so it's easy to spot who still needs paperwork uploaded.
  const docsPendingBadge = (a) => {
    const missing = MANAGED_DOC_FIELDS.some(([col]) => !a[col]);
    if (!missing) return '';
    return ' <span class="submission-status info_requested" title="Missing one or more of CIPC/ID, Proof of Address, or SARS Info">📋 Documents Pending</span>';
  };

  const importedBadge = (a) => a.registration_source === 'imported'
    ? ' <span class="submission-status" style="background:var(--bg-2); color:var(--border); border:1px solid var(--border);">Imported</span>'
    : '';

  const supplierNumberBadge = (a) => {
    if (!a.supplier_number) return '';
    return ` <span class="submission-status" style="background:var(--bg-1); color:var(--accent); border:1px solid var(--accent); font-weight:600;">${a.supplier_number}</span>`;
  };

  const statusActions = (a) => {
    const escapedName = (a.company_name || a.full_name || '').replace(/'/g, "\\'");
    if (a.status === 'active') {
      return `
        <button type="button" class="btn secondary" style="padding:6px 12px; font-size:12px;" onclick="suspendSupplier('${a.id}', '${escapedName}')">Suspend</button>
        <button type="button" class="btn secondary" style="padding:6px 12px; font-size:12px; color:#D32F2F; border-color:#D32F2F;" onclick="removeSupplier('${a.id}', '${escapedName}')">Remove</button>
      `;
    }
    if (a.status === 'suspended') {
      return `
        <button type="button" class="btn secondary" style="padding:6px 12px; font-size:12px;" onclick="reactivateSupplier('${a.id}', '${escapedName}')">Reactivate</button>
        <button type="button" class="btn secondary" style="padding:6px 12px; font-size:12px; color:#D32F2F; border-color:#D32F2F;" onclick="removeSupplier('${a.id}', '${escapedName}')">Remove</button>
      `;
    }
    // removed
    return `<button type="button" class="btn secondary" style="padding:6px 12px; font-size:12px;" onclick="restoreSupplier('${a.id}', '${escapedName}')">Restore</button>`;
  };

  list.innerHTML = toggleHtml + `
    <div style="max-height:600px; overflow-y:auto;">
      ${visibleApplicants.map(a => `
        <div style="padding:15px; border:1px solid var(--border); border-radius:4px; margin-bottom:10px; ${a.status !== 'active' ? 'background:var(--bg-2);' : ''}">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:10px;">
            <div>
              <p style="margin:0; font-weight:600;">${a.company_name}${supplierNumberBadge(a)}${statusBadge(a)}${docsPendingBadge(a)}${importedBadge(a)}</p>
              <p style="margin:2px 0 0 0; font-size:13px; color:var(--ink);">${a.title ? a.title + ' ' : ''}${a.full_name}${a.designation ? ' · ' + a.designation : ''}</p>
              <p style="margin:2px 0 0 0; font-size:12px; color:var(--border);">${a.email}${a.phone ? ' · ' + a.phone : ''}${a.additional_phone ? ' · ' + a.additional_phone : ''}</p>
            </div>
            <p style="margin:0; font-size:12px; color:var(--border); white-space:nowrap;">Registered ${new Date(a.created_at).toLocaleDateString()}</p>
          </div>
          ${a.status !== 'active' ? `
            <div style="margin-top:10px; padding:10px; background:white; border:1px solid var(--border); border-radius:4px; font-size:12px;">
              <p style="margin:0;"><strong>${a.status === 'suspended' ? 'Suspended' : 'Removed'} — reason:</strong> ${a.status_reason || '—'}</p>
              <p style="margin:4px 0 0 0; color:var(--border);">${a.status_changed_by ? 'By ' + a.status_changed_by + ' · ' : ''}${a.status_changed_at ? new Date(a.status_changed_at).toLocaleString() : ''}</p>
            </div>
          ` : ''}
          <div style="margin-top:10px; display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:6px 20px; font-size:12px; color:var(--ink);">
            <p style="margin:0;"><strong>Years in Business:</strong> ${a.years_in_business != null ? a.years_in_business : '—'}</p>
            <p style="margin:0;"><strong>Notify Province:</strong> ${a.province || '—'}</p>
            <p style="margin:0; grid-column:1/-1;"><strong>Address:</strong> ${a.address || '—'}</p>
            ${a.website_social ? `<p style="margin:0; grid-column:1/-1;"><strong>Website/Social:</strong> ${a.website_social}</p>` : ''}
            <p style="margin:0; grid-column:1/-1;"><strong>Services:</strong> ${a.services_description || '—'}</p>
            <p style="margin:0; grid-column:1/-1;"><strong>Service Areas:</strong> ${a.service_areas || '—'}</p>
          </div>
          <div style="margin-top:12px; display:flex; flex-wrap:wrap; gap:8px; align-items:center;">
            ${managedDocButtons(a)}
            ${otherDocFields(a).map(([label, path]) => `
              <button type="button" class="btn secondary" style="padding:6px 10px; font-size:12px;" onclick="downloadSupplierDocument('${path}', '${label.replace(/'/g, "\\'")}')">📄 ${label}</button>
            `).join('')}
          </div>
          <div style="margin-top:10px; display:flex; flex-wrap:wrap; gap:8px; border-top:1px solid var(--border); padding-top:10px;">
            ${canEditSection('applicants') ? `
              <button type="button" class="btn secondary" style="padding:6px 12px; font-size:12px;" onclick="openEditSupplierModal('${a.id}')">✏️ Edit</button>
              ${statusActions(a)}
            ` : ''}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// Fetches the full Supplier Database from the DB and populates the
// province filter's options (once), then hands off to renderSupplierList()
// for the actual (filterable, cheap) rendering.
async function loadSuperAdminApplicants() {
  try {
    const { data: applicants, error } = await client
      .from('applicant_registrations')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    allSupplierApplicants = applicants || [];

    const provinceFilter = document.getElementById('supplier-province-filter');
    if (provinceFilter && !provinceFilter.dataset.populated) {
      provinceFilter.insertAdjacentHTML('beforeend', PROVINCE_OPTIONS.map(p => `<option value="${p}">${p}</option>`).join(''));
      provinceFilter.dataset.populated = 'true';
    }

    const editProvinceSelect = document.getElementById('edit-supplier-province');
    if (editProvinceSelect && !editProvinceSelect.dataset.populated) {
      editProvinceSelect.insertAdjacentHTML('beforeend', PROVINCE_OPTIONS.map(p => `<option value="${p}">${p}</option>`).join(''));
      editProvinceSelect.dataset.populated = 'true';
    }

    renderSupplierList();
  } catch (err) {
    console.error('Error loading applicants:', err);
    const list = document.getElementById('super-admin-applicants-list');
    if (list) list.innerHTML = '<p style="color:var(--warning);">Error loading registered applicants.</p>';
  }
}

// Uploads a new file for one of the 3 admin-manageable mandatory
// documents (CIPC/ID, Proof of Address, SARS Info) and points the
// supplier's row at it — used both to fill in a missing document (e.g.
// after a bulk import) and to replace an existing one. The old file (if
// any) is left in storage rather than deleted, same tradeoff already
// accepted elsewhere in this app for superseded links/tokens.
let pendingSupplierDocUpload = null; // { applicantId, column, keyPrefix, label }

function uploadOrReplaceSupplierDocument(applicantId, column, keyPrefix, label) {
  pendingSupplierDocUpload = { applicantId, column, keyPrefix, label };
  const input = document.getElementById('supplier-doc-upload-input');
  if (!input) return;
  input.value = '';
  input.click();
}

async function handleSupplierDocFileSelected(e) {
  const file = e.target.files[0];
  const pending = pendingSupplierDocUpload;
  pendingSupplierDocUpload = null;
  if (!file || !pending) return;

  try {
    const path = await uploadSupplierDocument(pending.applicantId, pending.keyPrefix, file);
    const { error } = await client
      .from('applicant_registrations')
      .update({ [pending.column]: path })
      .eq('id', pending.applicantId);
    if (error) throw error;
    showToast(`✅ ${pending.label} uploaded.`, 'success');
    loadSuperAdminApplicants();
  } catch (err) {
    console.error('Error uploading supplier document:', err);
    showToast('❌ Error uploading document: ' + err.message, 'error');
  }
}

// ---------------------------------------------------------------------
// Import Suppliers: upload a CSV/Excel export of an existing supplier
// list, map its columns onto our fields (auto-guessed, editable), preview
// what will and won't be imported, then bulk-insert. Documents and the
// registration declaration are deliberately NOT part of this flow — per
// Brent's instruction, imported suppliers get flagged "Documents Pending"
// (see docsPendingBadge above) and documents/declaration are added later,
// one at a time, via the per-supplier Upload/Replace buttons.
// ---------------------------------------------------------------------

const IMPORT_TARGET_FIELDS = [
  { key: 'company_name', label: 'Company Name *', required: true, synonyms: ['company name', 'company', 'business name', 'organisation', 'organization', 'trading name'] },
  { key: 'full_name', label: 'Contact Person *', required: true, synonyms: ['contact person', 'contact name', 'full name', 'name', 'contact'] },
  { key: 'email', label: 'Email *', required: true, synonyms: ['email address', 'email', 'e-mail'] },
  { key: 'phone', label: 'Phone', required: false, synonyms: ['phone', 'cell', 'cell number', 'mobile', 'telephone', 'contact number', 'tel'] },
  { key: 'additional_phone', label: 'Additional Phone', required: false, synonyms: ['additional phone', 'alternative phone', 'alt phone', 'second number', 'other phone'] },
  { key: 'title', label: 'Title (Ms/Mrs/Mr/Dr/Professor)', required: false, synonyms: ['title'] },
  { key: 'designation', label: 'Designation', required: false, synonyms: ['designation', 'position', 'job title', 'role'] },
  { key: 'years_in_business', label: 'Years in Business', required: false, synonyms: ['years in business', 'years trading', 'years operating', 'years'] },
  { key: 'address', label: 'Address', required: false, synonyms: ['address', 'physical address', 'location'] },
  { key: 'province', label: 'Notify Province', required: false, synonyms: ['province', 'region'] },
  { key: 'website_social', label: 'Website / Social', required: false, synonyms: ['website', 'social media', 'social', 'url', 'web'] },
  { key: 'services_description', label: 'Services', required: false, synonyms: ['services', 'service description', 'services offered', 'products/services'] },
  { key: 'service_areas', label: 'Service Areas', required: false, synonyms: ['service areas', 'areas served', 'coverage area', 'areas covered'] }
];

let importWizardState = null; // { headers, rows, mapping }

function openImportSuppliersModal() {
  importWizardState = null;
  document.getElementById('import-suppliers-body').innerHTML = `
    <div>
      <label style="display:block; margin-bottom:8px; font-weight:600; font-size:13px;">Choose a CSV or Excel (.xlsx/.xls) file</label>
      <input type="file" id="import-file-input" accept=".csv,.xlsx,.xls" onchange="handleImportFileSelected(event)" style="padding:8px; border:1px solid var(--border); border-radius:4px; width:100%;">
      <div id="import-file-status" style="margin-top:10px; font-size:12px; color:var(--border);"></div>
    </div>
  `;
  openModal('import-suppliers-modal');
}

function guessColumnForField(headers, synonyms, usedHeaders) {
  const available = headers.filter(h => !usedHeaders.has(h));
  const normalized = available.map(h => (h || '').toString().trim().toLowerCase());
  for (const syn of synonyms) {
    const exactIdx = normalized.indexOf(syn);
    if (exactIdx !== -1) return available[exactIdx];
  }
  // Substring fallback is intentionally last-resort and only matches a
  // whole word/token (split on any non-alphanumeric run), not a raw
  // substring — otherwise a synonym like "address" would wrongly latch
  // onto an unrelated column such as "Email Address" before the real
  // "Address" (or no) column is ever considered.
  for (const syn of synonyms) {
    const idx = normalized.findIndex(h => h.split(/[^a-z0-9]+/).includes(syn));
    if (idx !== -1) return available[idx];
  }
  return '';
}

function handleImportFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById('import-file-status');
  if (statusEl) statusEl.textContent = 'Reading file...';

  const reader = new FileReader();
  reader.onload = (evt) => {
    try {
      if (typeof XLSX === 'undefined') {
        throw new Error('File-reading library failed to load. Check your connection and try again.');
      }
      const workbook = XLSX.read(evt.target.result, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[firstSheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });

      if (!rows.length) {
        if (statusEl) statusEl.textContent = 'No rows found in that file — check it has a header row and at least one data row.';
        return;
      }

      const headers = Object.keys(rows[0]);
      const mapping = {};
      const usedHeaders = new Set();
      IMPORT_TARGET_FIELDS.forEach(f => {
        const guess = guessColumnForField(headers, f.synonyms, usedHeaders);
        mapping[f.key] = guess;
        if (guess) usedHeaders.add(guess);
      });

      importWizardState = { headers, rows, mapping };
      renderImportMappingStep();
    } catch (err) {
      console.error('Error reading import file:', err);
      if (statusEl) statusEl.textContent = '❌ Could not read that file: ' + err.message;
    }
  };
  reader.onerror = () => {
    if (statusEl) statusEl.textContent = '❌ Could not read that file.';
  };
  reader.readAsArrayBuffer(file);
}

function updateImportMapping(fieldKey, column) {
  if (!importWizardState) return;
  importWizardState.mapping[fieldKey] = column;
}

function renderImportMappingStep() {
  const { headers, rows, mapping } = importWizardState;
  const columnOptionsHtml = (selected) => [
    `<option value=""${selected ? '' : ' selected'}>-- Not in file --</option>`,
    ...headers.map(h => `<option value="${escapeHtmlClient(h)}"${h === selected ? ' selected' : ''}>${escapeHtmlClient(h)}</option>`)
  ].join('');

  document.getElementById('import-suppliers-body').innerHTML = `
    <p style="margin:0 0 15px 0; font-size:13px;"><strong>${rows.length}</strong> row${rows.length === 1 ? '' : 's'} found. Match each field below to a column from your file (auto-matched where possible) — leave "Not in file" for anything you don't have.</p>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px 16px; max-height:340px; overflow-y:auto; padding-right:4px;">
      ${IMPORT_TARGET_FIELDS.map(f => `
        <div>
          <label style="display:block; font-size:12px; font-weight:600; margin-bottom:4px;">${f.label}</label>
          <select onchange="updateImportMapping('${f.key}', this.value)" style="width:100%; padding:8px; border:1px solid var(--border); border-radius:4px; font-size:13px;">
            ${columnOptionsHtml(mapping[f.key])}
          </select>
        </div>
      `).join('')}
    </div>
    <div style="margin-top:20px; display:flex; gap:10px; justify-content:flex-end;">
      <button type="button" class="btn secondary" onclick="openImportSuppliersModal()">Start Over</button>
      <button type="button" class="btn gold" onclick="renderImportPreviewStep()">Preview Import</button>
    </div>
  `;
}

function renderImportPreviewStep() {
  const { rows, mapping } = importWizardState;
  const missingRequired = IMPORT_TARGET_FIELDS.filter(f => f.required && !mapping[f.key]);
  if (missingRequired.length > 0) {
    showToast('❌ Please map: ' + missingRequired.map(f => f.label).join(', '), 'error');
    return;
  }

  const existingEmails = new Set(allSupplierApplicants.map(a => (a.email || '').trim().toLowerCase()));
  const seenInFile = new Set();
  const toImport = [];
  let skippedMissing = 0;
  let skippedDuplicate = 0;

  const getVal = (row, key) => {
    const col = mapping[key];
    if (!col) return '';
    return (row[col] === undefined || row[col] === null) ? '' : row[col].toString().trim();
  };

  rows.forEach(row => {
    const companyName = getVal(row, 'company_name');
    const fullName = getVal(row, 'full_name');
    const email = getVal(row, 'email').toLowerCase();

    if (!companyName || !fullName || !email) { skippedMissing++; return; }
    if (existingEmails.has(email) || seenInFile.has(email)) { skippedDuplicate++; return; }
    seenInFile.add(email);

    const titleRaw = getVal(row, 'title');
    const title = ['Ms', 'Mrs', 'Mr', 'Dr', 'Professor'].find(t => t.toLowerCase() === titleRaw.toLowerCase()) || null;

    const provinceRaw = getVal(row, 'province');
    const province = [...PROVINCE_OPTIONS, 'ALL'].find(p => p.toLowerCase() === provinceRaw.toLowerCase()) || null;

    const yearsRaw = getVal(row, 'years_in_business');
    const yearsParsed = parseInt(yearsRaw, 10);
    const yearsInBusiness = (Number.isFinite(yearsParsed) && yearsParsed >= 0) ? yearsParsed : null;

    toImport.push({
      id: generateUUID(),
      company_name: companyName,
      full_name: fullName,
      email,
      phone: getVal(row, 'phone') || null,
      additional_phone: getVal(row, 'additional_phone') || null,
      title,
      designation: getVal(row, 'designation') || null,
      years_in_business: yearsInBusiness,
      address: getVal(row, 'address') || null,
      province,
      website_social: getVal(row, 'website_social') || null,
      services_description: getVal(row, 'services_description') || null,
      service_areas: getVal(row, 'service_areas') || null,
      declaration_accepted: false,
      registration_source: 'imported'
    });
  });

  importWizardState.toImport = toImport;

  document.getElementById('import-suppliers-body').innerHTML = `
    <div style="padding:12px; background:var(--bg-2); border-radius:4px; font-size:13px; margin-bottom:15px;">
      <p style="margin:0;"><strong>${toImport.length}</strong> supplier${toImport.length === 1 ? '' : 's'} ready to import.</p>
      ${skippedMissing > 0 ? `<p style="margin:4px 0 0 0; color:var(--warning);">${skippedMissing} row${skippedMissing === 1 ? '' : 's'} skipped — missing Company Name, Contact Person, or Email.</p>` : ''}
      ${skippedDuplicate > 0 ? `<p style="margin:4px 0 0 0; color:var(--border);">${skippedDuplicate} row${skippedDuplicate === 1 ? '' : 's'} skipped — already in the Supplier Database (or duplicated in the file).</p>` : ''}
    </div>
    ${toImport.length > 0 ? `
      <p style="margin:0 0 8px 0; font-size:12px; color:var(--border);">Preview (first 5):</p>
      <div style="max-height:180px; overflow-y:auto; font-size:12px; border:1px solid var(--border); border-radius:4px; padding:10px;">
        ${toImport.slice(0, 5).map(r => `<p style="margin:0 0 6px 0;">${escapeHtmlClient(r.company_name)} — ${escapeHtmlClient(r.full_name)} (${escapeHtmlClient(r.email)})</p>`).join('')}
      </div>
    ` : ''}
    <div style="margin-top:20px; display:flex; gap:10px; justify-content:flex-end;">
      <button type="button" class="btn secondary" onclick="renderImportMappingStep()">Back</button>
      <button type="button" class="btn gold" ${toImport.length === 0 ? 'disabled' : ''} onclick="runSupplierImport()">Import ${toImport.length} Supplier${toImport.length === 1 ? '' : 's'}</button>
    </div>
  `;
}

async function runSupplierImport() {
  if (!importWizardState || !importWizardState.toImport || importWizardState.toImport.length === 0) return;
  const rows = importWizardState.toImport;

  try {
    const { error } = await client.from('applicant_registrations').insert(rows);
    if (error) throw error;
    showToast(`✅ Imported ${rows.length} supplier${rows.length === 1 ? '' : 's'}. They're flagged "Documents Pending" until documents are uploaded.`, 'success');
    closeModal('import-suppliers-modal');
    importWizardState = null;
    loadSuperAdminApplicants();
  } catch (err) {
    console.error('Error importing suppliers:', err);
    showToast('❌ Import failed: ' + err.message, 'error');
  }
}

// Suspend/remove/reactivate/restore a supplier. Suspended and removed both
// stop them from applying to RFQs (enforced at the DB/RLS level, not just
// here — see the rfq_submissions insert policy) but per Brent's explicit
// instruction they can still browse/view RFQs either way. "Removed" is
// reversible (restore below), not a hard delete — the record, reason, and
// documents are kept, just hidden from the default list.
async function suspendSupplier(applicantId, name) {
  const reason = prompt(`Reason for suspending "${name}"?`);
  if (reason === null) return; // cancelled
  if (!reason.trim()) {
    showToast('❌ A reason is required to suspend a supplier.', 'error');
    return;
  }
  try {
    const { error } = await client
      .from('applicant_registrations')
      .update({
        status: 'suspended',
        status_reason: reason.trim(),
        status_changed_at: new Date().toISOString(),
        status_changed_by: currentUser ? currentUser.email : 'unknown'
      })
      .eq('id', applicantId);
    if (error) throw error;
    showToast(`✅ ${name} suspended.`, 'success');
    loadSuperAdminApplicants();
  } catch (err) {
    console.error('Error suspending supplier:', err);
    showToast('❌ Error: ' + err.message, 'error');
  }
}

async function removeSupplier(applicantId, name) {
  const reason = prompt(`Reason for removing "${name}"? This can be undone later via "Restore".`);
  if (reason === null) return; // cancelled
  if (!reason.trim()) {
    showToast('❌ A reason is required to remove a supplier.', 'error');
    return;
  }
  try {
    const { error } = await client
      .from('applicant_registrations')
      .update({
        status: 'removed',
        status_reason: reason.trim(),
        status_changed_at: new Date().toISOString(),
        status_changed_by: currentUser ? currentUser.email : 'unknown'
      })
      .eq('id', applicantId);
    if (error) throw error;
    showToast(`✅ ${name} removed from the Supplier Database.`, 'success');
    loadSuperAdminApplicants();
  } catch (err) {
    console.error('Error removing supplier:', err);
    showToast('❌ Error: ' + err.message, 'error');
  }
}

async function reactivateSupplier(applicantId, name) {
  if (!confirm(`Reactivate "${name}"? They will be able to apply to RFQs again.`)) return;
  try {
    const { error } = await client
      .from('applicant_registrations')
      .update({
        status: 'active',
        status_reason: null,
        status_changed_at: new Date().toISOString(),
        status_changed_by: currentUser ? currentUser.email : 'unknown'
      })
      .eq('id', applicantId);
    if (error) throw error;
    showToast(`✅ ${name} reactivated.`, 'success');
    loadSuperAdminApplicants();
  } catch (err) {
    console.error('Error reactivating supplier:', err);
    showToast('❌ Error: ' + err.message, 'error');
  }
}

async function restoreSupplier(applicantId, name) {
  if (!confirm(`Restore "${name}" to the Supplier Database as active?`)) return;
  try {
    const { error } = await client
      .from('applicant_registrations')
      .update({
        status: 'active',
        status_reason: null,
        status_changed_at: new Date().toISOString(),
        status_changed_by: currentUser ? currentUser.email : 'unknown'
      })
      .eq('id', applicantId);
    if (error) throw error;
    showToast(`✅ ${name} restored.`, 'success');
    loadSuperAdminApplicants();
  } catch (err) {
    console.error('Error restoring supplier:', err);
    showToast('❌ Error: ' + err.message, 'error');
  }
}

// Edit a supplier's own profile fields directly (name/contact/address/
// services/etc.) — separate from the status actions above (suspend/
// remove/reactivate/restore) and from the per-document upload/replace
// buttons, neither of which this touches. Available regardless of the
// supplier's current status, since a suspended/removed supplier's details
// can still need correcting.
let pendingEditSupplierId = null;

function openEditSupplierModal(applicantId) {
  const a = allSupplierApplicants.find(x => x.id === applicantId);
  if (!a) return;
  pendingEditSupplierId = applicantId;

  document.getElementById('edit-supplier-company-name').value = a.company_name || '';
  document.getElementById('edit-supplier-full-name').value = a.full_name || '';
  document.getElementById('edit-supplier-title').value = a.title || '';
  document.getElementById('edit-supplier-designation').value = a.designation || '';
  document.getElementById('edit-supplier-email').value = a.email || '';
  document.getElementById('edit-supplier-province').value = a.province || '';
  document.getElementById('edit-supplier-phone').value = a.phone || '';
  document.getElementById('edit-supplier-additional-phone').value = a.additional_phone || '';
  document.getElementById('edit-supplier-years').value = a.years_in_business != null ? a.years_in_business : '';
  document.getElementById('edit-supplier-website').value = a.website_social || '';
  document.getElementById('edit-supplier-address').value = a.address || '';
  document.getElementById('edit-supplier-services').value = a.services_description || '';
  document.getElementById('edit-supplier-service-areas').value = a.service_areas || '';

  openModal('edit-supplier-modal');
}

async function handleEditSupplierSubmit(e) {
  e.preventDefault();
  if (!pendingEditSupplierId) return;

  const companyName = document.getElementById('edit-supplier-company-name').value.trim();
  const fullName = document.getElementById('edit-supplier-full-name').value.trim();
  const email = document.getElementById('edit-supplier-email').value.trim();

  if (!companyName || !fullName || !email) {
    showToast('❌ Company Name, Contact Person, and Email are required.', 'error');
    return;
  }

  const yearsRaw = document.getElementById('edit-supplier-years').value;

  const payload = {
    company_name: companyName,
    full_name: fullName,
    email: email,
    title: document.getElementById('edit-supplier-title').value || null,
    designation: document.getElementById('edit-supplier-designation').value.trim() || null,
    province: document.getElementById('edit-supplier-province').value || null,
    phone: document.getElementById('edit-supplier-phone').value.trim() || null,
    additional_phone: document.getElementById('edit-supplier-additional-phone').value.trim() || null,
    years_in_business: yearsRaw !== '' ? Number(yearsRaw) : null,
    website_social: document.getElementById('edit-supplier-website').value.trim() || null,
    address: document.getElementById('edit-supplier-address').value.trim() || null,
    services_description: document.getElementById('edit-supplier-services').value.trim() || null,
    service_areas: document.getElementById('edit-supplier-service-areas').value.trim() || null
  };

  const submitBtn = document.getElementById('edit-supplier-submit');
  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving...';

  try {
    const { error } = await client
      .from('applicant_registrations')
      .update(payload)
      .eq('id', pendingEditSupplierId);
    if (error) {
      // Postgres unique_violation — most likely the new email already
      // belongs to another registered supplier (applicant_registrations
      // has a unique index on lower(email)).
      if (error.code === '23505') {
        throw new Error('That email address is already used by another supplier.');
      }
      throw error;
    }
    showToast('✅ Supplier updated.', 'success');
    closeModal('edit-supplier-modal');
    pendingEditSupplierId = null;
    loadSuperAdminApplicants();
  } catch (err) {
    console.error('Error updating supplier:', err);
    showToast('❌ Error: ' + err.message, 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  }
}

async function toggleCompanyStatus(companyId, currentStatus) {
  const newStatus = currentStatus === 'active' ? 'suspended' : 'active';
  try {
    const { error } = await client
      .from('companies')
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', companyId);
    if (error) throw error;
    showToast(`✅ Company ${newStatus}`, 'success');
    loadSuperAdminCompanies();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

async function deleteCompany(companyId, companyName) {
  const confirmed = window.confirm(`Permanently delete "${companyName}" and all of its RFQs, invitations and submissions? This cannot be undone.`);
  if (!confirmed) return;

  try {
    const { error } = await client.from('companies').delete().eq('id', companyId);
    if (error) throw error;
    showToast('✅ Company deleted', 'success');
    loadSuperAdminCompanies();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

// ===== UTILITY FUNCTIONS =====
function showToast(message, type = 'info') {
  const wrap = document.getElementById('toast-wrap');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  wrap.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'slideOut 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.style.display = 'flex';
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.style.display = 'none';
}

function generateToken() {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `token-${random}-${timestamp}`;
}

function generateUUID() {
  if (window.crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // RFC4122 v4 fallback for older browsers
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast('✅ Link copied!', 'success');
  }).catch(() => {
    showToast('Error copying', 'error');
  });
}

async function copyAllRFQLinks(rfqId) {
  try {
    const { data: invitations } = await client
      .from('rfq_invitations')
      .select('*')
      .eq('rfq_id', rfqId);

    if (!invitations || invitations.length === 0) {
      showToast('No contractor links to copy', 'info');
      return;
    }

    const baseUrl = window.location.origin + window.location.pathname;
    const allLinks = invitations.map(inv => `${baseUrl}?rfq=${inv.invitation_token}`).join('\n');

    navigator.clipboard.writeText(allLinks).then(() => {
      showToast(`✅ ${invitations.length} links copied!`, 'success');
    }).catch(() => {
      showToast('Error copying', 'error');
    });
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

async function showAddContractorForm(rfqId) {
  const email = prompt('Enter contractor email:');
  if (!email) return;

  try {
    // Only actually email this contractor if the RFQ has already been
    // released — otherwise their link would be unreachable anyway (see
    // rfqs_select_scoped) and Brent's "nothing goes out until released"
    // rule applies here too, not just to the bulk save/create flow.
    const { data: rfqRow } = await client
      .from('rfqs')
      .select('is_released')
      .eq('id', rfqId)
      .single();
    const isReleased = !!(rfqRow && rfqRow.is_released);

    const { data: inv, error } = await client
      .from('rfq_invitations')
      .insert([{
        rfq_id: rfqId,
        contractor_email: email,
        invitation_token: generateToken(),
        used: false
      }])
      .select()
      .single();

    if (error) throw error;

    const baseUrl = window.location.origin + window.location.pathname;
    const link = `${baseUrl}?rfq=${inv.invitation_token}`;
    navigator.clipboard.writeText(link);

    if (isReleased) {
      showToast('✅ Contractor added — sending invite email...', 'success');
      await sendRFQInviteEmails(rfqId, [inv]);
    } else {
      showToast('✅ Contractor added — will be emailed when this RFQ is released', 'success');
    }
    loadRFQConsole();

  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

function showGeneratedLinks(rfqId, invitations) {
  window.lastInvitations = invitations;

  const baseUrl = window.location.origin + window.location.pathname;

  let linksHtml = '<div style="font-family: monospace; font-size: 12px; line-height: 1.8;">';

  invitations.forEach((inv, idx) => {
    const link = `${baseUrl}?rfq=${inv.invitation_token}`;
    linksHtml += `
      <div style="margin-bottom: 20px; padding-bottom: 15px; border-bottom: 1px solid var(--border);">
        <strong style="color: var(--ink);">${idx + 1}. ${inv.contractor_email}</strong><br>
        <code style="background: var(--bg-2); padding: 8px; display: block; word-break: break-all; margin-top: 5px; border-radius: 4px;">${link}</code>
      </div>
    `;
  });

  linksHtml += '</div>';

  const linksContainer = document.getElementById('generated-links-list');
  if (linksContainer) linksContainer.innerHTML = linksHtml;

  openModal('generated-links-modal');
}

function copyAllLinks() {
  if (!window.lastInvitations || window.lastInvitations.length === 0) {
    showToast('No links to copy', 'error');
    return;
  }

  const baseUrl = window.location.origin + window.location.pathname;
  const links = window.lastInvitations.map(inv => {
    return `${baseUrl}?rfq=${inv.invitation_token}`;
  }).join('\n');

  navigator.clipboard.writeText(links).then(() => {
    showToast('✅ URLs copied!', 'success');
  }).catch(() => {
    showToast('Error copying', 'error');
  });
}

async function downloadDocument(path, name) {
  try {
    const { data, error } = await client.storage.from('rfq-documents').createSignedUrl(path, 120);
    if (error) throw error;
    if (data && data.signedUrl) {
      const link = document.createElement('a');
      link.href = data.signedUrl;
      link.download = name;
      link.target = '_blank';
      link.click();
      showToast('✅ Download started', 'success');
    }
  } catch (err) {
    console.error('Download error:', err);
    showToast('Error downloading document: ' + err.message, 'error');
  }
}

// Same pattern as downloadDocument() above, but against the private
// 'supplier-documents' bucket (only readable by the super admin) used for
// Supplier Database registration documents.
async function downloadSupplierDocument(path, name) {
  try {
    const { data, error } = await client.storage.from('supplier-documents').createSignedUrl(path, 120);
    if (error) throw error;
    if (data && data.signedUrl) {
      const link = document.createElement('a');
      link.href = data.signedUrl;
      link.download = name;
      link.target = '_blank';
      link.click();
      showToast('✅ Download started', 'success');
    }
  } catch (err) {
    console.error('Download error:', err);
    showToast('Error downloading document: ' + err.message, 'error');
  }
}

function acceptPOPIA() {
  closeModal('popia-modal');
}

// ===== SUPPLIER DATABASE EXPORT FUNCTIONS =====

function exportSuppliersAsCSV() {
  const allApplicants = allSupplierApplicants;
  if (!allApplicants || allApplicants.length === 0) {
    showToast('❌ No suppliers to export', 'error');
    return;
  }

  // CSV headers
  const headers = ['Company Name', 'Contact Person', 'Email', 'Phone', 'Additional Phone', 'Address', 'Province', 'Years in Business', 'Services', 'Status', 'Registered Date'];

  // CSV rows
  const rows = allApplicants.map(supplier => [
    `"${(supplier.company_name || '').replace(/"/g, '""')}"`,
    `"${(supplier.full_name || '').replace(/"/g, '""')}"`,
    `"${(supplier.email || '').replace(/"/g, '""')}"`,
    `"${(supplier.phone || '').replace(/"/g, '""')}"`,
    `"${(supplier.additional_phone || '').replace(/"/g, '""')}"`,
    `"${(supplier.address || '').replace(/"/g, '""')}"`,
    `"${(supplier.province || '').replace(/"/g, '""')}"`,
    supplier.years_in_business || '',
    `"${(supplier.services_description || '').replace(/"/g, '""')}"`,
    supplier.status || 'active',
    supplier.created_at ? new Date(supplier.created_at).toLocaleDateString() : ''
  ]);

  // Combine headers and rows
  const csv = [headers.join(','), ...rows.map(row => row.join(','))].join('\n');

  // Download
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.setAttribute('href', url);
  link.setAttribute('download', `RFQHub_Suppliers_${new Date().toISOString().split('T')[0]}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  showToast('✅ Suppliers exported as CSV', 'success');
}

function exportSuppliersAsExcel() {
  const allApplicants = allSupplierApplicants;
  if (!allApplicants || allApplicants.length === 0) {
    showToast('❌ No suppliers to export', 'error');
    return;
  }

  // For Excel, we'll use a simple approach: create an HTML table and let the browser handle it
  // Or we can use SheetJS if available, otherwise fall back to CSV-like format

  // Create HTML table
  let html = '<table border="1" cellpadding="10">';
  html += '<tr style="background-color:#0F3557; color:white;"><th>Company Name</th><th>Contact Person</th><th>Email</th><th>Phone</th><th>Additional Phone</th><th>Address</th><th>Province</th><th>Years in Business</th><th>Services</th><th>Status</th><th>Registered Date</th></tr>';

  allApplicants.forEach(supplier => {
    const statusColor = supplier.status === 'suspended' ? '#FFC107' : supplier.status === 'removed' ? '#DC3545' : '#28A745';
    html += `<tr>
      <td>${supplier.company_name || ''}</td>
      <td>${supplier.full_name || ''}</td>
      <td>${supplier.email || ''}</td>
      <td>${supplier.phone || ''}</td>
      <td>${supplier.additional_phone || ''}</td>
      <td>${supplier.address || ''}</td>
      <td>${supplier.province || ''}</td>
      <td>${supplier.years_in_business || ''}</td>
      <td>${supplier.services_description || ''}</td>
      <td><span style="background-color:${statusColor}; color:white; padding:4px 8px; border-radius:4px;">${supplier.status || 'active'}</span></td>
      <td>${supplier.created_at ? new Date(supplier.created_at).toLocaleDateString() : ''}</td>
    </tr>`;
  });

  html += '</table>';

  // Create and download Excel-like file (xlsx format using a simple approach)
  // We'll create a blob with HTML that Excel can read
  const blob = new Blob(['<html><head><meta charset="UTF-8"></head><body>' + html + '</body></html>'], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.setAttribute('href', url);
  link.setAttribute('download', `RFQHub_Suppliers_${new Date().toISOString().split('T')[0]}.xls`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  showToast('✅ Suppliers exported as Excel', 'success');
}

// Initialize on page load
window.addEventListener('DOMContentLoaded', () => {
  console.log('Page loaded, initializing...');
  setupCreateRFQForm();

  const provinceFilter = document.getElementById('public-rfq-province-filter');
  if (provinceFilter) {
    provinceFilter.addEventListener('change', () => loadPublicRFQList());
  }

  const sortFilter = document.getElementById('public-rfq-sort');
  if (sortFilter) {
    sortFilter.addEventListener('change', () => loadPublicRFQList());
  }

  const heroSearchForm = document.getElementById('hero-search-form');
  if (heroSearchForm) {
    heroSearchForm.addEventListener('submit', (e) => {
      e.preventDefault();
      loadPublicRFQList();
    });
  }

  const footerYear = document.getElementById('footer-year');
  if (footerYear) {
    footerYear.textContent = new Date().getFullYear();
  }
});
