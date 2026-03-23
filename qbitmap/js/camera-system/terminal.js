import { Logger } from '../utils.js';

/**
 * QBitmap Camera System - Terminal Module
 * Handles terminal panel, commands, and boot sequence
 */

// [PERF] Maximum terminal lines to prevent memory leak (24h usage could be 100MB+)
const MAX_TERMINAL_LINES = 500;

const TerminalMixin = {
  /**
   * Toggle terminal panel
   */
  toggleTerminalPanel(deviceId, event) {
    const existingPanel = document.getElementById('ai-detection-panel');
    if (existingPanel) {
      existingPanel.remove();
      return;
    }

    const btn = event.currentTarget;
    const popupData = this.popups.get(deviceId);
    if (!popupData) return;
    const popupEl = popupData.popup.getElement();
    const popupContent = popupEl?.querySelector('.camera-popup-content');
    if (!popupContent) return;

    const popupRect = popupContent.getBoundingClientRect();

    const panel = document.createElement('div');
    panel.id = 'ai-detection-panel';
    panel.className = 'ai-panel';
    panel.dataset.deviceId = deviceId;
    panel.innerHTML = `
      <div class="ai-panel-header">
        <span class="ai-panel-title">Deep Surve Terminal v0.9</span>
        <button class="cam-btn close-btn ai-panel-close" title="Kapat">&times;</button>
      </div>
      <div class="ai-terminal">
        <div class="ai-terminal-output"></div>
        <div class="ai-terminal-input-line">
          <span class="ai-terminal-prompt">&gt;</span>
          <input type="text" class="ai-terminal-input" placeholder="start" autocomplete="off" disabled>
        </div>
      </div>
    `;

    // Boot sequence
    this.runBootSequence(deviceId, panel);

    // Position panel to the right of camera card, aligned with top
    panel.style.position = 'fixed';
    panel.style.top = `${popupRect.top}px`;
    panel.style.left = `${popupRect.right + 8}px`;
    panel.style.zIndex = '9999';

    document.body.appendChild(panel);

    // Make panel draggable by header
    this.makeDraggable(panel, panel.querySelector('.ai-panel-header'));

    // Animate in
    requestAnimationFrame(() => {
      panel.classList.add('active');
    });

    // Close button - only closes panel, AI continues in background
    panel.querySelector('.ai-panel-close').onclick = () => {
      panel.classList.remove('active');
      setTimeout(() => panel.remove(), 200);
    };

    // Close on outside click - only closes panel, AI continues
    const closeOnOutside = (e) => {
      if (!panel.contains(e.target) && e.target !== btn) {
        panel.classList.remove('active');
        setTimeout(() => panel.remove(), 200);
        document.removeEventListener('click', closeOnOutside);
      }
    };
    setTimeout(() => document.addEventListener('click', closeOnOutside), 100);

    // Terminal input handler
    const input = panel.querySelector('.ai-terminal-input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const command = input.value.trim();
        if (command) {
          this.handleTerminalCommand(deviceId, command);
          input.value = '';
        }
      }
    });

    // Focus input
    setTimeout(() => input.focus(), 100);
  },

  /**
   * Handle terminal command
   */
  handleTerminalCommand(deviceId, command) {
    const cmd = command.toLowerCase().trim();

    // Echo command
    this.terminalWrite(deviceId, `> ${command}`, false);

    if (cmd === 'start') {
      this.terminalWrite(deviceId, '[SYS] Surveillance baslatiliyor...', true);
      this.startVisionMonitoring(deviceId);
    } else if (cmd === 'stop') {
      this.stopVisionMonitoring(deviceId);
      this.terminalWrite(deviceId, '[SYS] Surveillance durduruldu.', true);
    } else if (cmd === 'help') {
      this.terminalWrite(deviceId, '[SYS] Komutlar:', true);
      this.terminalWrite(deviceId, '  start - Izlemeyi baslat', true);
      this.terminalWrite(deviceId, '  stop  - Izlemeyi durdur', true);
      this.terminalWrite(deviceId, '  clear - Ekrani temizle', true);
      this.terminalWrite(deviceId, '  exit  - Terminali kapat', true);
    } else if (cmd === 'clear') {
      const panel = document.getElementById('ai-detection-panel');
      const output = panel?.querySelector('.ai-terminal-output');
      if (output) output.innerHTML = '';
    } else if (cmd === 'exit') {
      this.stopVisionMonitoring(deviceId);
      const panel = document.getElementById('ai-detection-panel');
      if (panel) {
        panel.classList.remove('active');
        setTimeout(() => panel.remove(), 200);
      }
    } else {
      this.terminalWrite(deviceId, `[ERR] Bilinmeyen komut: ${command}`, true);
    }
  },

  /**
   * Write to terminal with typewriter effect
   * [PERF] Trims old lines to prevent memory leak
   */
  terminalWrite(deviceId, text, isSystem = false) {
    const panel = document.getElementById('ai-detection-panel');
    const output = panel?.querySelector('.ai-terminal-output');
    if (!output) return;

    const line = document.createElement('div');
    line.className = isSystem ? 'terminal-line system' : 'terminal-line';
    output.appendChild(line);

    // [PERF] Remove oldest lines if over limit
    while (output.children.length > MAX_TERMINAL_LINES) {
      output.removeChild(output.firstChild);
    }

    // Typewriter effect
    let i = 0;
    const timer = setInterval(() => {
      line.textContent += text.charAt(i);
      i++;
      if (i >= text.length) clearInterval(timer);
      output.scrollTop = output.scrollHeight;
    }, 20);
  },

  /**
   * Start vision monitoring
   */
  startVisionMonitoring(deviceId) {
    this.toggleFallDetection(deviceId, true);
  },

  /**
   * Stop vision monitoring
   */
  async stopVisionMonitoring(deviceId) {
    await this.toggleFallDetection(deviceId, false);
  },

  /**
   * Run boot sequence animation
   */
  runBootSequence(deviceId, panel) {
    const output = panel.querySelector('.ai-terminal-output');
    const input = panel.querySelector('.ai-terminal-input');
    if (!output || !input) return;

    const bootMessages = [
      { text: '[BOOT] Deep Surve v2.4.1 initializing...', delay: 10, isSystem: true },
      { text: '[GPU] 4 x RTX PRO 6000 Blackwell', delay: 400, isSystem: true },
      { text: '[GPU] Total VRAM: 384 GB GDDR7', delay: 800, isSystem: true },
      { text: '[MEM] System RAM: 1536 GB DDR5-6400', delay: 1200, isSystem: true },
      { text: '[NPU] Neural Engine: 2.8 PFLOPS', delay: 1600, isSystem: true },
      { text: '[NET] Secure connection established', delay: 2000, isSystem: true },
      { text: '[AI] Loading Qbitwise Vision model...', delay: 2400, isSystem: true },
      { text: '[AI] Vision module ready', delay: 3800, isSystem: true },
      { text: '[SYS] All systems operational', delay: 4200, isSystem: true },
      { text: '-----------------------------------', delay: 4600, isSystem: false },
      { text: 'Type "start" to begin surveillance', delay: 4800, isSystem: false },
    ];

    bootMessages.forEach(({ text, delay, isSystem }) => {
      setTimeout(() => {
        this.terminalWriteInstant(output, text, isSystem);
      }, delay);
    });

    // Enable input after boot completes
    setTimeout(() => {
      input.disabled = false;
      input.focus();
    }, 4000);
  },

  /**
   * Write to terminal instantly (for boot sequence)
   * [PERF] Trims old lines to prevent memory leak
   */
  terminalWriteInstant(output, text, isSystem = false) {
    const line = document.createElement('div');
    line.className = isSystem ? 'terminal-line system' : 'terminal-line';
    line.textContent = text;
    output.appendChild(line);

    // [PERF] Remove oldest lines if over limit
    while (output.children.length > MAX_TERMINAL_LINES) {
      output.removeChild(output.firstChild);
    }

    output.scrollTop = output.scrollHeight;
  },

  /**
   * Make an element draggable by a handle
   */
  makeDraggable(element, handle) {
    let offsetX = 0, offsetY = 0, startX = 0, startY = 0;
    let isDragging = false;

    handle.style.cursor = 'move';

    const onMouseDown = (e) => {
      if (e.target.closest('.ai-panel-close')) return;

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      e.preventDefault();
    };

    const onMouseMove = (e) => {
      if (!isDragging) return;

      offsetX = e.clientX - startX;
      offsetY = e.clientY - startY;
      startX = e.clientX;
      startY = e.clientY;

      const rect = element.getBoundingClientRect();
      let newLeft = rect.left + offsetX;
      let newTop = rect.top + offsetY;

      // Keep within viewport
      newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - rect.width));
      newTop = Math.max(0, Math.min(newTop, window.innerHeight - rect.height));

      element.style.left = newLeft + 'px';
      element.style.top = newTop + 'px';
    };

    const onMouseUp = () => {
      isDragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    // Mouse events
    handle.addEventListener('mousedown', onMouseDown);

    // Touch events for mobile
    handle.addEventListener('touchstart', (e) => {
      if (e.target.closest('.ai-panel-close')) return;
      const touch = e.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      isDragging = true;
    }, { passive: true });

    handle.addEventListener('touchmove', (e) => {
      if (!isDragging) return;
      const touch = e.touches[0];

      offsetX = touch.clientX - startX;
      offsetY = touch.clientY - startY;
      startX = touch.clientX;
      startY = touch.clientY;

      const rect = element.getBoundingClientRect();
      let newLeft = rect.left + offsetX;
      let newTop = rect.top + offsetY;

      newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - rect.width));
      newTop = Math.max(0, Math.min(newTop, window.innerHeight - rect.height));

      element.style.left = newLeft + 'px';
      element.style.top = newTop + 'px';
    }, { passive: true });

    handle.addEventListener('touchend', () => {
      isDragging = false;
    });
  }
};

export { TerminalMixin };
