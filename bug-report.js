(function () {
    // Inject styles
    const style = document.createElement('style');
    style.textContent = `
        #bug-report-fab {
            position: fixed; bottom: 48px; left: 20px; z-index: 99998;
            background: rgba(220,38,38,0.85); color: white; border: none; border-radius: 50px;
            padding: 5px 11px 5px 8px; font-size: 10px; font-weight: 600; cursor: pointer;
            display: none; align-items: center; gap: 4px;
            box-shadow: 0 2px 8px rgba(220,38,38,0.25);
            transition: opacity 0.15s, transform 0.15s;
            font-family: 'Inter', Arial, sans-serif;
            opacity: 0.6; letter-spacing: 0.2px;
        }
        #bug-report-fab:hover { opacity: 1; transform: translateY(-1px); }
        #bug-report-overlay {
            display: none; position: fixed; inset: 0; z-index: 99999;
            background: rgba(0,0,0,0.5); align-items: center; justify-content: center;
        }
        #bug-report-overlay.open { display: flex; }
        #bug-report-modal {
            background: white; border-radius: 16px; padding: 28px; width: 100%; max-width: 480px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.2); font-family: 'Inter', Arial, sans-serif;
            max-height: 90vh; overflow-y: auto;
        }
        .brm-label { font-size: 11px; font-weight: 800; color: #475569; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 5px; display: block; }
        .brm-input { width: 100%; border: 1px solid #e2e8f0; border-radius: 8px; padding: 9px 12px; font-size: 13px; font-family: inherit; box-sizing: border-box; outline: none; }
        .brm-input:focus { border-color: #dc2626; box-shadow: 0 0 0 3px rgba(220,38,38,0.1); }
        .brm-textarea { resize: vertical; min-height: 100px; }
        #bug-screenshot-preview { display: none; margin-top: 8px; max-width: 100%; border-radius: 8px; border: 1px solid #e2e8f0; }
    `;
    document.head.appendChild(style);

    // FAB button
    const fab = document.createElement('button');
    fab.id = 'bug-report-fab';
    fab.innerHTML = '<span style="font-size:11px;">🐛</span> Report a Bug';
    document.body.appendChild(fab);

    // Overlay + Modal
    const overlay = document.createElement('div');
    overlay.id = 'bug-report-overlay';
    overlay.innerHTML = `
        <div id="bug-report-modal">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
                <div style="font-size:17px;font-weight:800;color:#dc2626;">🐛 Report a Bug</div>
                <button id="brm-close" style="background:none;border:none;cursor:pointer;color:#94a3b8;font-size:20px;line-height:1;">✕</button>
            </div>

            <div id="brm-reporter-info" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:12px;color:#475569;">
                <span style="font-weight:700;">Reporting as:</span> <span id="brm-reporter-display">—</span>
            </div>

            <div style="margin-bottom:14px;">
                <label class="brm-label">Describe the bug *</label>
                <textarea id="brm-description" class="brm-input brm-textarea" placeholder="What happened? What did you expect to happen? Steps to reproduce..."></textarea>
            </div>

            <div style="margin-bottom:20px;">
                <label class="brm-label">Screenshot (optional)</label>
                <input type="file" id="brm-screenshot" accept="image/*" class="brm-input" style="padding:6px 10px;">
                <img id="bug-screenshot-preview" />
            </div>

            <div style="display:flex;gap:10px;">
                <button id="brm-cancel" style="flex:1;padding:10px;border:1px solid #e2e8f0;border-radius:8px;background:white;cursor:pointer;font-weight:700;font-size:13px;color:#475569;">Cancel</button>
                <button id="brm-submit" style="flex:2;padding:10px;background:#dc2626;color:white;border:none;border-radius:8px;cursor:pointer;font-weight:800;font-size:13px;">Send Report</button>
            </div>
            <div id="brm-status" style="text-align:center;font-size:12px;margin-top:10px;min-height:16px;"></div>
        </div>`;
    document.body.appendChild(overlay);

    // Helpers
    const $ = id => document.getElementById(id);

    function getReporter() {
        const fn = localStorage.getItem('pp_user_first_name') || '';
        const ln = localStorage.getItem('pp_user_last_name') || '';
        const name = [fn, ln].filter(Boolean).join(' ');
        const email = localStorage.getItem('pp_user_email') || localStorage.getItem('pp_userid') || '';
        return { name: name || email || 'Unknown', email };
    }

    function openModal() {
        const r = getReporter();
        $('brm-reporter-display').textContent = r.name + (r.email && r.email !== r.name ? ` (${r.email})` : '');
        $('brm-description').value = '';
        $('brm-screenshot').value = '';
        $('bug-screenshot-preview').style.display = 'none';
        $('brm-status').textContent = '';
        overlay.classList.add('open');
    }

    function closeModal() { overlay.classList.remove('open'); }

    // Screenshot preview
    $('brm-screenshot').addEventListener('change', function () {
        const file = this.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = e => {
            $('bug-screenshot-preview').src = e.target.result;
            $('bug-screenshot-preview').style.display = 'block';
        };
        reader.readAsDataURL(file);
    });

    // Submit
    $('brm-submit').addEventListener('click', async function () {
        const description = $('brm-description').value.trim();
        if (!description) { $('brm-status').innerHTML = '<span style="color:#dc2626;">Please describe the bug.</span>'; return; }

        this.disabled = true;
        this.textContent = 'Sending…';
        $('brm-status').textContent = '';

        const r = getReporter();
        let screenshotPath = null;

        // Upload screenshot if provided
        const screenshotFile = $('brm-screenshot').files[0];
        if (screenshotFile) {
            try {
                const supabaseUrl = 'https://zuzwljjrppyrzngmhdru.supabase.co';
                const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1endsampycHB5cnpuZ21oZHJ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1NjI3NjQsImV4cCI6MjA4ODEzODc2NH0.C7883WzNJIyqrc5vcWrOFPPDfjq7DAZhw2oQKFpwoow';
                const ext = screenshotFile.name.split('.').pop();
                const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
                const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/bug-reports/${path}`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': screenshotFile.type },
                    body: screenshotFile
                });
                if (uploadRes.ok) screenshotPath = path;
            } catch (e) { console.warn('Screenshot upload failed:', e.message); }
        }

        try {
            const resp = await fetch('/api/bug-report', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    description,
                    page_url: window.location.href,
                    reporter_name: r.name,
                    reporter_email: r.email,
                    screenshot_path: screenshotPath
                })
            });
            const result = await resp.json();
            if (result.success) {
                $('brm-status').innerHTML = '<span style="color:#16a34a;font-weight:700;">✓ Report sent successfully!</span>';
                setTimeout(closeModal, 1500);
            } else {
                throw new Error(result.message || 'Failed to send');
            }
        } catch (e) {
            $('brm-status').innerHTML = `<span style="color:#dc2626;">${e.message}</span>`;
        } finally {
            this.disabled = false;
            this.textContent = 'Send Report';
        }
    });

    fab.addEventListener('click', openModal);
    $('brm-close').addEventListener('click', closeModal);
    $('brm-cancel').addEventListener('click', closeModal);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

    // Only show the FAB when authenticated
    function isAuthed() {
        return (localStorage.getItem('pp_verified') === 'true' && !!localStorage.getItem('pp_session_token'))
            || !!localStorage.getItem('pp_partner_token');
    }
    function showFab() { fab.style.display = 'flex'; }

    if (isAuthed()) {
        showFab();
    } else {
        // On index.html: watch #page-curtain becoming visible after login
        const curtain = document.getElementById('page-curtain');
        if (curtain) {
            const obs = new MutationObserver(() => {
                if (curtain.style.display && curtain.style.display !== 'none') {
                    obs.disconnect();
                    showFab();
                }
            });
            obs.observe(curtain, { attributes: true, attributeFilter: ['style'] });
        }
    }
})();
