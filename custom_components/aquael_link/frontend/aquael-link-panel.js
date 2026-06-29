const PANEL_STATIC_URL = "/aquael_link_panel";
const PANEL_VERSION = "0.31";

class AquaelLinkPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._devices = [];
    this._selected = null;
    this._loaded = false;
    this._hypermaxModes = {};
    this._pending = {};
    this._pendingTimers = {};
    this._optimisticSwitch = null;
    this._tankPhoto = this._loadTankPhoto();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._loaded) {
      this._loadDevices();
      return;
    }
    if (this._dragging || this._iframeMode) {
      return;
    }

    const active = this.shadowRoot && this.shadowRoot.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
      return;
    }

    const sig = this._stateSignature();
    if (sig !== this._lastSig) {
      this._render();
    }
  }

  _stateSignature() {
    if (!this._hass) {
      return "";
    }
    const parts = [];
    for (const device of this._devices || []) {
      for (const id of Object.values(device.entities || {})) {
        const st = this._hass.states[id];
        parts.push(
          id + "=" + (st
            ? st.state + "|" + (st.attributes.temperature != null ? st.attributes.temperature : "") +
              "|" + (st.attributes.current_temperature != null ? st.attributes.current_temperature : "") +
              "|" + (st.attributes.brightness != null ? st.attributes.brightness : "") +
              "|" + (Array.isArray(st.attributes.rgbw_color) ? st.attributes.rgbw_color.join(",") : "")
            : "")
        );
      }
    }
    return parts.join(";");
  }

  connectedCallback() {
    this._render();
  }

  async _loadDevices() {
    if (!this._hass) {
      return;
    }
    this._loaded = true;
    try {
      const response = await this._hass.callWS({ type: "aquael_link/panel_devices" });
      this._devices = response.devices || [];
      this._selected = this._devices[0] || null;
    } catch (err) {
      this._error = err && err.message ? err.message : String(err);
    }
    this._render();
  }

  _selectDevice(device) {
    this._selected = device;
    if (device && device.type === "hypermax") {
      delete this._hypermaxModes[device.entry_id];
    }
    this._render();
  }

  _setHypermaxMode(entryId, mode) {
    if (mode === "menu") {
      delete this._hypermaxModes[entryId];
      this._render();
      return;
    }
    if (mode === "identify") {
      const device = this._devices.find((d) => d.entry_id === entryId);
      const entities = (device && device.entities) || {};
      if (entities.identify) {
        this._callService("button", "press", { entity_id: entities.identify });
        this._showToast("Diody urządzenia migają przez kilka sekund");
      } else {
        this._showToast("Brak encji identyfikacji — przeładuj integrację");
      }
      return;
    }
    this._hypermaxModes[entryId] = mode;
    this._render();
  }

  async _callService(domain, service, data) {
    if (!this._hass) {
      return;
    }
    await this._hass.callService(domain, service, data);
  }

  _entity(entityId) {
    return entityId && this._hass ? this._hass.states[entityId] : null;
  }

  _entityValue(entityId, fallback = "—") {
    const state = this._entity(entityId);
    if (!state || state.state === "unknown" || state.state === "unavailable") {
      return fallback;
    }
    const unit = state.attributes.unit_of_measurement || "";
    return `${state.state}${unit ? ` ${unit}` : ""}`;
  }

  _isOn(entityId) {
    const state = this._entity(entityId);
    const opt = this._optimisticSwitch;
    if (opt && opt.id === entityId) {
      if (state && state.state === opt.state) {
        this._optimisticSwitch = null;
      } else {
        return opt.state === "on";
      }
    }
    return state && state.state === "on";
  }


  _pendingNumber(entityId, fallback) {
    if (entityId && this._pending[entityId] != null) {
      const real = this._numberState(entityId, NaN);
      if (Number.isFinite(real) && Math.abs(real - this._pending[entityId]) < 0.001) {
        delete this._pending[entityId];
        return real;
      }
      return this._pending[entityId];
    }
    return this._numberState(entityId, fallback);
  }


  _bumpNumber(entityId, delta, min, max, fallback) {
    if (!entityId) {
      return;
    }
    const base = this._pendingNumber(entityId, fallback);
    const start = Number.isFinite(base) ? base : fallback;
    const next = Math.max(min, Math.min(max, Math.round((start + delta) * 10) / 10));
    this._pending[entityId] = next;
    this._render();
    clearTimeout(this._pendingTimers[entityId]);
    this._pendingTimers[entityId] = setTimeout(async () => {
      const value = this._pending[entityId];
      try {
        await this._callService("number", "set_value", { entity_id: entityId, value });
      } catch (err) {
        delete this._pending[entityId];
        this._showToast("Błąd zapisu: " + ((err && err.message) || err));
        this._render();
      }
    }, 600);
  }

  _numberState(entityId, fallback = NaN) {
    const state = this._entity(entityId);
    if (!state || state.state === "unknown" || state.state === "unavailable") {
      return fallback;
    }
    const value = Number(String(state.state).replace(",", "."));
    return Number.isFinite(value) ? value : fallback;
  }

  _yesState(entityId) {
    const state = this._entity(entityId);
    if (!state || state.state === "unknown" || state.state === "unavailable") {
      return null;
    }
    return ["on", "true", "tak", "yes", "1"].includes(String(state.state).toLowerCase());
  }

  _deviceByType(type) {
    return (this._devices || []).find((device) => device.type === type) || null;
  }

  _aquariumDevices() {
    return {
      hypermax: this._deviceByType("hypermax"),
      thermometer: this._deviceByType("thermometer"),
      light: this._deviceByType("light"),
      socket: this._deviceByType("socket"),
    };
  }

  _formatTemp(value) {
    return Number.isFinite(value) ? `${value.toFixed(1)}°C` : "—";
  }

  _formatPct(value) {
    return Number.isFinite(value) ? `${Math.round(value)}%` : "—";
  }

  _socketModeLabel(entityId) {
    const state = this._entity(entityId);
    if (!state || state.state === "unknown" || state.state === "unavailable") {
      return "—";
    }
    const labels = { Dzien: "Day", Swit: "Daybreak", Noc: "Night", Wlaczone: "On", Wylaczone: "Off" };
    return labels[state.state] || state.state;
  }

  _loadTankPhoto() {
    try {
      return window.localStorage ? window.localStorage.getItem("aquaelLinkTankPhoto") || "" : "";
    } catch (err) {
      return "";
    }
  }

  _saveTankPhoto(dataUrl) {
    this._tankPhoto = dataUrl || "";
    try {
      if (window.localStorage) {
        if (this._tankPhoto) {
          window.localStorage.setItem("aquaelLinkTankPhoto", this._tankPhoto);
        } else {
          window.localStorage.removeItem("aquaelLinkTankPhoto");
        }
      }
    } catch (err) {
      this._showToast("Zdjęcie działa w tej sesji, ale przeglądarka nie zapisała go lokalnie");
    }
  }

  _resizeTankPhoto(file) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type || !file.type.startsWith("image/")) {
        reject(new Error("Wybierz plik graficzny"));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Nie mogę odczytać zdjęcia"));
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => reject(new Error("Nie mogę przygotować podglądu"));
        image.onload = () => {
          const maxSide = 1400;
          const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
          const width = Math.max(1, Math.round(image.width * scale));
          const height = Math.max(1, Math.round(image.height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(image, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", 0.84));
        };
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  _renderAquariumCockpit() {
    const devices = this._aquariumDevices();
    if (!devices.hypermax && !devices.thermometer && !devices.light && !devices.socket) {
      return "";
    }
    const h = (devices.hypermax && devices.hypermax.entities) || {};
    const t = (devices.thermometer && devices.thermometer.entities) || {};
    const l = (devices.light && devices.light.entities) || {};
    const s = (devices.socket && devices.socket.entities) || {};
    const climate = this._entity(h.thermostat);
    const thermometerWater = this._numberState(t.water_temperature, NaN);
    const hyperCurrent = climate && climate.attributes.current_temperature != null
      ? Number(climate.attributes.current_temperature)
      : this._numberState(h.current_temperature, NaN);
    const waterTemp = Number.isFinite(thermometerWater) ? thermometerWater : hyperCurrent;
    const target = climate && climate.attributes.temperature != null
      ? Number(climate.attributes.temperature)
      : this._numberState(h.target_temperature, NaN);
    const efficiency = this._numberState(h.filter_efficiency, NaN);
    const topPower = this._numberState(h.top_heater_power, 0);
    const bottomPower = this._numberState(h.bottom_heater_power, 0);
    const heaterPower = topPower + bottomPower;
    const thermostatOn = climate ? climate.state === "heat" : this._isOn(h.thermostat_switch);
    const pumpOn = this._isOn(h.pump);
    const light = this._entity(l.light);
    const lightOn = light && light.state === "on";
    const red = this._numberState(l.light_red, NaN);
    const blue = this._numberState(l.light_blue, NaN);
    const white = this._numberState(l.light_white, NaN);
    const ch1On = this._isOn(s.output_1);
    const ch2On = this._isOn(s.output_2);
    const ch1Mode = this._socketModeLabel(s.output_1_mode);
    const ch2Mode = this._socketModeLabel(s.output_2_mode);
    const tempState =!Number.isFinite(waterTemp)
      ? "muted"
      : waterTemp < 24.0
        ? "cold"
        : waterTemp > 27.0
          ? "warm"
          : "ok";
    const tempText = tempState === "cold"
      ? "za zimno"
      : tempState === "warm"
        ? "za ciepło"
        : tempState === "ok"
          ? "stabilnie"
          : "czekam na pomiar";
    const heatingText = !devices.hypermax
      ? "—"
      : thermostatOn
        ? (heaterPower > 0 ? "grzałki " + Math.round(heaterPower) + "%" : "gotowy")
        : "wyłączony";
    const filterText = !devices.hypermax ? "—" : pumpOn ? this._formatPct(efficiency) : "wył.";
    const filterSub = !devices.hypermax ? "" : pumpOn ? "pompa pracuje" : "pompa zatrzymana";
    const lightText = !devices.light
      ? "—"
      : lightOn
        ? [Number.isFinite(white) ? "W " + Math.round(white) : "", Number.isFinite(blue) ? "B " + Math.round(blue) : "", Number.isFinite(red) ? "R " + Math.round(red) : ""].filter(Boolean).join(" · ") || "włączone"
        : "wyłączone";
    return `
    <section class="aquarium-card">
      <div class="aq-card-header">
        <strong>Akwarium</strong>
        <div class="aq-photo-controls">
          ${this._tankPhoto ? `
            <button class="aq-photo-btn" type="button" data-aq-photo-clear title="Usuń zdjęcie">
              <ha-icon icon="mdi:image-off-outline"></ha-icon>
            </button>
          ` : ""}
          <label class="aq-photo-btn" title="Dodaj zdjęcie akwarium">
            <ha-icon icon="mdi:camera-outline"></ha-icon>
            <input type="file" accept="image/*" data-aq-photo-input>
          </label>
        </div>
      </div>

      <div class="aq-tank-strip"><img src="${this._escape(this._tankPhoto || (PANEL_STATIC_URL + "/aq-default-tank.jpg"))}" alt="Akwarium"></div>

      <div class="aq-metrics">
        <div class="aq-metric ${tempState}">
          <span>Temperatura</span>
          <strong>${this._escape(this._formatTemp(waterTemp))}</strong>
          <small>${this._escape(tempText)}</small>
        </div>
        ${devices.hypermax ? `
        <div class="aq-metric">
          <span>Termostat</span>
          <strong>${this._escape(this._formatTemp(target))}</strong>
          <small>${this._escape(heatingText)}</small>
        </div>
        ` : ""}
        ${devices.hypermax ? `
        <div class="aq-metric">
          <span>Filtr</span>
          <strong>${this._escape(filterText)}</strong>
          <small>${this._escape(filterSub)}</small>
        </div>
        ` : ""}
        ${devices.light ? `
        <div class="aq-metric">
          <span>Światło</span>
          <strong>${lightOn ? "wł." : "wył."}</strong>
          <small>${this._escape(lightText)}</small>
        </div>
        ` : ""}
        ${devices.socket ? `
        <div class="aq-metric">
          <span>Kanał 1</span>
          <strong>${ch1On ? this._escape(ch1Mode) : "wył."}</strong>
          <small>${ch1On ? "Day&amp;Night" : ""}</small>
        </div>
        <div class="aq-metric">
          <span>Kanał 2</span>
          <strong>${ch2On ? this._escape(ch2Mode) : "wył."}</strong>
          <small>${ch2On ? "Day&amp;Night" : ""}</small>
        </div>
        ` : ""}
      </div>

      <div class="aq-controls">
        ${devices.light ? `
        <div class="aq-ctrl-group">
          <div class="aq-ctrl-label"><ha-icon icon="mdi:lightbulb-outline"></ha-icon>Preset lampy</div>
          <div class="aq-ctrl-btns">
            <button data-aq-light="preset_plant"><ha-icon icon="mdi:leaf"></ha-icon>Roślinny</button>
            <button data-aq-light="preset_sunny"><ha-icon icon="mdi:white-balance-sunny"></ha-icon>Słoneczny</button>
            <button data-aq-light="preset_marine"><ha-icon icon="mdi:waves"></ha-icon>Marine</button>
            <button data-aq-light="off"><ha-icon icon="mdi:power"></ha-icon>Wyłącz</button>
          </div>
          <div class="aq-channel-board">
            ${this._renderLightChannelSlider("red", "R", "mdi:circle", red)}
            ${this._renderLightChannelSlider("blue", "B", "mdi:circle", blue)}
            ${this._renderLightChannelSlider("white", "W", "mdi:white-balance-sunny", white)}
          </div>
        </div>
        ` : ""}
        ${devices.socket ? `
        <div class="aq-ctrl-group">
          <div class="aq-ctrl-label"><ha-icon icon="mdi:theme-light-dark"></ha-icon>Day&amp;Night</div>
          <div class="aq-socket-channel">
            <div class="aq-socket-ch-head">
              <span>Kanał 1</span>
              <button class="aq-socket-toggle ${ch1On ? "active" : ""}" data-aq-socket="1:toggle">
                <ha-icon icon="mdi:power"></ha-icon>${ch1On ? "On" : "Off"}
              </button>
            </div>
            ${ch1On ? `
            <div class="aq-ctrl-btns">
              <button data-aq-socket="1:Swit"><ha-icon icon="mdi:weather-sunset-up"></ha-icon>Daybreak</button>
              <button data-aq-socket="1:Dzien"><ha-icon icon="mdi:white-balance-sunny"></ha-icon>Day</button>
              <button data-aq-socket="1:Noc"><ha-icon icon="mdi:weather-night"></ha-icon>Night</button>
            </div>` : ""}
          </div>
          <div class="aq-socket-channel">
            <div class="aq-socket-ch-head">
              <span>Kanał 2</span>
              <button class="aq-socket-toggle ${ch2On ? "active" : ""}" data-aq-socket="2:toggle">
                <ha-icon icon="mdi:power"></ha-icon>${ch2On ? "On" : "Off"}
              </button>
            </div>
            ${ch2On ? `
            <div class="aq-ctrl-btns">
              <button data-aq-socket="2:Swit"><ha-icon icon="mdi:weather-sunset-up"></ha-icon>Daybreak</button>
              <button data-aq-socket="2:Dzien"><ha-icon icon="mdi:white-balance-sunny"></ha-icon>Day</button>
              <button data-aq-socket="2:Noc"><ha-icon icon="mdi:weather-night"></ha-icon>Night</button>
            </div>` : ""}
          </div>
        </div>
        ` : ""}
      </div>
    </section>
  `;
  }

  _renderDeviceButton(device) {
    const selected = this._selected && this._selected.entry_id === device.entry_id;
    const thumbnails = {
      hypermax: "ios-hypermax.png",
      thermometer: "ios-thermometer.png",
      light: "ios-light.png",
      socket: "ios-socket-duo.png",
    };
    const icons = {
      hypermax: "mdi:filter-variant",
      thermometer: "mdi:thermometer-lines",
      light: "mdi:lightbulb-outline",
      socket: "mdi:power-socket-eu",
    };
    const thumbnail = thumbnails[device.type];
    const icon = icons[device.type] || "mdi:devices";
    const media = thumbnail
      ? `<img class="tile-thumb tile-thumb--${this._escape(device.type)}" src="${PANEL_STATIC_URL}/${thumbnail}?v=20260610-ios-icons-v1" alt="">`
      : `<ha-icon icon="${icon}"></ha-icon>`;
    const original = device.original_identifier || device.name || "";
    const custom = device.name && device.name !== original ? device.name : "";
    const details = [custom, device.ip].filter(Boolean).join(" · ");
    return `
      <button class="tile ${selected ? "selected" : ""}" data-entry-id="${device.entry_id}">
        ${media}
        <span>
          <strong>${this._escape(original)}</strong>
          ${details ? `<small>${this._escape(details)}</small>` : ""}
        </span>
      </button>
    `;
  }

  _renderHypermax(device) {
    const entities = device.entities || {};
    const climate = this._entity(entities.thermostat);
    const target = climate && climate.attributes.temperature != null
      ? Number(climate.attributes.temperature)
      : this._numberState(entities.target_temperature);
    const current = climate && climate.attributes.current_temperature != null
      ? Number(climate.attributes.current_temperature)
      : this._numberState(entities.current_temperature);
    const efficiencyState = this._entity(entities.filter_efficiency);
    const efficiency = efficiencyState ? Number(efficiencyState.state) : NaN;
    const waterOk = this._yesState(entities.water_sensor_flooded);
    const topPower = this._numberState(entities.top_heater_power, 0);
    const bottomPower = this._numberState(entities.bottom_heater_power, 0);
    const thermostatOn = climate ? climate.state === "heat" : this._isOn(entities.thermostat);
    const pumpOn = this._isOn(entities.pump);
    const heating = topPower + bottomPower > 0;
    const targetText = Number.isFinite(target) ? target.toFixed(1) : "—";
    const currentText = Number.isFinite(current) ? current.toFixed(1) : "—";
    const mode = this._hypermaxModes[device.entry_id];

    return `
      <section class="hypermax-shell">
        ${!mode
          ? this._renderHypermaxChooser(device)
          : mode === "flow"        ? this._renderHypermaxFlow(device, efficiency, pumpOn)
          : mode === "thermostat"  ? this._renderHypermaxThermostat(device, thermostatOn, pumpOn, waterOk, heating, targetText, currentText)
          : mode === "chart"       ? this._renderHypermaxChart(device)
          : mode === "notifications" ? this._renderHypermaxNotifications(device)
          : mode === "offset"      ? this._renderHypermaxOffset(device)
          : mode === "security"    ? this._renderHypermaxSecurity(device)
          : mode === "settings"    ? this._renderHypermaxSettings(device)
          : ""}
      </section>
    `;
  }

  _renderHypermaxChooser(device) {
    const entities = device.entities || {};
    const current = this._entityValue(entities.current_temperature, "—");
    const pumpOn = this._isOn(entities.pump);
    const heatOn = this._isOn(entities.thermostat_switch) || (() => {
      const c = this._entity(entities.thermostat);
      return c ? c.state === "heat" : false;
    })();
    const items = [
      ["settings", "mdi:cog-outline", "Ustawienia", "Szczegóły i preferencje urządzenia"],
      ["flow", "mdi:pump", "Wydajność filtra", "Ustaw wydajność i tryb pracy pompy"],
      ["thermostat", "mdi:thermometer", "Termostatowanie", "Zarządzaj termostatowaniem"],
      ["chart", "mdi:chart-line", "Temperatura", "Zobacz historię"],
      ["security", "mdi:lock-outline", "Bezpieczeństwo", "Zabezpiecz dostęp kodem PIN"],
      ["notifications", "mdi:bell-outline", "Powiadomienia", "Informuj o wybranych zdarzeniach"],
      ["offset", "mdi:tune-variant", "Przesunięcie temperatury", "Zwiększ dokładność pomiaru"],
      ["identify", "mdi:lightbulb-on-outline", "Identyfikuj", "Diody migają przez kilka sekund"],
    ];
    return `
      <div class="hm-screen">
        <div class="hm-card hm-device-card">
          <img src="${PANEL_STATIC_URL}/ios-hypermax.png" alt="">
          <div class="hm-device-info">
            <button class="hm-device-name" data-rename title="Kliknij, aby zmienić nazwę">${this._escape(device.name)}</button>
            <span>${this._escape(device.original_identifier || "HYPERMAX")} · ${this._escape(device.ip || "")}</span>
            <div class="hm-chips">
              <span class="hm-chip"><ha-icon icon="mdi:thermometer-water"></ha-icon>${this._escape(current)}</span>
              <span class="hm-chip ${pumpOn ? "on" : ""}"><ha-icon icon="mdi:pump"></ha-icon>Pompa ${pumpOn ? "wł." : "wył."}</span>
              <span class="hm-chip ${heatOn ? "on" : ""}"><ha-icon icon="mdi:radiator"></ha-icon>Grzanie ${heatOn ? "wł." : "wył."}</span>
            </div>
          </div>
          <button class="hm-icon-btn" data-rename aria-label="Zmień nazwę">
            <ha-icon icon="mdi:pencil"></ha-icon>
          </button>
        </div>
        <div class="hm-card hm-menu">
          ${items.map(([mode, icon, title, sub]) => `
            <button class="hm-row" data-mode="${mode}">
              <span class="hm-row-icon"><ha-icon icon="${icon}"></ha-icon></span>
              <span class="hm-row-text"><strong>${title}</strong><small>${sub}</small></span>
              <ha-icon class="hm-chevron" icon="mdi:chevron-right"></ha-icon>
            </button>
          `).join("")}
        </div>
      </div>
    `;
  }

  _renderHaHeader(title) {
    return `
      <header class="hm-topbar">
        <button class="hm-icon-btn" data-mode="menu" aria-label="Wróć">
          <ha-icon icon="mdi:arrow-left"></ha-icon>
        </button>
        <strong>${this._escape(title)}</strong>
      </header>
    `;
  }

  _renderIosSlider(value, min, max, downAction, upAction) {
    const percent = Number.isFinite(value) ? ((value - min) / (max - min)) * 100 : 50;
    const kind = downAction.indexOf("temp") === 0 ? "temp" : "eff";
    const base = Number.isFinite(value) ? value : min;
    const cfg = this._escape(JSON.stringify({ min, max, base, kind }));
    const label = Number.isFinite(value) ? value : "\u2014";
    return `
      <div class="ios-slider" style="--pos: ${Math.max(0, Math.min(100, percent))}%" data-knob="${cfg}">
        <button data-action="${downAction}" aria-label="Zmniejsz">\u2212</button>
        <div><i data-knob-handle><b>${label}</b></i></div>
        <button data-action="${upAction}" aria-label="Zwieksz">+</button>
      </div>
    `;
  }

  _renderHypermaxThermostat(device, thermostatOn, pumpOn, waterOk, heating, targetText, currentText) {
    return `
      <div class="ios-screen ios-control-screen" style="position:relative;">
        <button class="ios-back ios-back--float" data-mode="menu" aria-label="Wróć"></button>
        <iframe class="hypermax-frame hypermax-frame--phone" src="${this._escape(this._controlUrl(device, "thermostat"))}"></iframe>
      </div>
    `;
  }

  _controlUrl(device, mode) {
    const e = device.entities || {};
    const token = (this._hass && this._hass.auth && this._hass.auth.data && this._hass.auth.data.access_token) || "";
    if (mode === "thermostat") {
      const params = new URLSearchParams({ token: token, climate: e.thermostat || "" });
      return `${PANEL_STATIC_URL}/aquael_hypermax/thermostat.html?v=20260611-controls-offset-016-v1#` + params.toString();
    }
    const params = new URLSearchParams({ token: token, number: e.filter_efficiency || "", pump: e.pump || "" });
    return `${PANEL_STATIC_URL}/aquael_hypermax/flow.html?v=20260611-controls-offset-016-v1#` + params.toString();
  }

  _renderHypermaxFlow(device, efficiency, pumpOn) {
    return `
      <div class="ios-screen ios-control-screen" style="position:relative;">
        <button class="ios-back ios-back--float" data-mode="menu" aria-label="Wróć"></button>
        <iframe class="hypermax-frame hypermax-frame--phone" src="${this._escape(this._controlUrl(device, "flow"))}"></iframe>
      </div>
    `;
  }

  _renderHypermaxChart(device) {
    const url = device.chart_url || "";
    const token = (this._hass && this._hass.auth && this._hass.auth.data && this._hass.auth.data.access_token) || "";
    const chartUrl = url ? `${url}#${new URLSearchParams({ token }).toString()}` : "";
    return `
      <div class="ios-screen ios-control-screen" style="position:relative;">
        <button class="ios-back ios-back--float" data-mode="menu" aria-label="Wróć"></button>
        ${chartUrl ? `<iframe class="hypermax-frame hypermax-frame--full" src="${this._escape(chartUrl)}"></iframe>` : `<div class="empty">Brak wykresu dla tego urządzenia.</div>`}
      </div>
    `;
  }

  _renderHypermaxNotifications(device) {
    const entities = device.entities || {};
    const notifyOn = this._isOn(entities.notify);
    const minVal = this._pendingNumber(entities.notify_min, 20);
    const maxVal = this._pendingNumber(entities.notify_max, 30);
    return `
      <div class="hm-screen">
        ${this._renderHaHeader("Powiadomienia")}
        <div class="hm-card hm-list">
          <div class="hm-setting-row">
            <span>Włącz powiadomienia</span>
            ${this._renderMiniToggle(notifyOn, "toggle-notify")}
          </div>
          <div class="hm-section-title">Zakres temperatury</div>
          <div class="hm-setting-row">
            <span>Kiedy spadnie poniżej [°C]</span>
            <div class="hm-stepper">
              <button data-action="notify-min-down">−</button>
              <b>${Number.isFinite(minVal) ? minVal.toFixed(1) : "—"}</b>
              <button data-action="notify-min-up">+</button>
            </div>
          </div>
          <div class="hm-setting-row">
            <span>Kiedy wzrośnie powyżej [°C]</span>
            <div class="hm-stepper">
              <button data-action="notify-max-down">−</button>
              <b>${Number.isFinite(maxVal) ? maxVal.toFixed(1) : "—"}</b>
              <button data-action="notify-max-up">+</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  _renderHypermaxOffset(device) {
    const entities = device.entities || {};
    const offset = this._numberState(entities.temp_offset, 0);
    const value = Number.isFinite(offset) ? offset : 0;
    return `
      <div class="hm-screen">
        ${this._renderHaHeader("Przesunięcie temperatury")}
        <div class="hm-card hm-list">
          <div class="hm-section-title">Przesunięcie dla wody</div>
          <div class="hm-setting-row hm-offset-row">
            <input type="range" min="-5" max="5" step="0.1" value="${value}" data-offset-slider />
            <b class="hm-offset-value">${value.toFixed(1)}°C</b>
          </div>
        </div>
      </div>
    `;
  }

  _renderMiniToggle(on, action) {
    return `
      <label class="hm-toggle ${on ? "on" : ""}">
        <input type="checkbox" ${on ? "checked" : ""} data-action="${action}" />
        <i></i>
      </label>
    `;
  }

  _renderHypermaxSecurity(device) {
    const pinOn = String(device.pin_state || "Off").toLowerCase() === "on";
    const code = pinOn && device.pin_code ? String(device.pin_code) : "";
    return `
      <div class="hm-screen">
        ${this._renderHaHeader("Bezpieczeństwo")}
        <div class="hm-card hm-list">
          <div class="hm-setting-row">
            <span>Zabezpiecz kodem PIN</span>
            ${this._renderMiniToggle(pinOn, "toggle-pin")}
          </div>
          <div class="hm-section-title">Kod PIN</div>
          <div class="hm-setting-row">
            <span>Kod (6 cyfr)</span>
            <input class="hm-pin-input" type="text" inputmode="numeric" maxlength="6"
                   value="${this._escape(code)}" placeholder="np. 123456" data-pin-input />
          </div>
          <div class="hm-setting-row hm-setting-row--actions">
            <button class="hm-save-btn" data-action="save-pin">Zachowaj</button>
          </div>
        </div>
      </div>
    `;
  }

  _renderHypermaxSettings(device) {
    const entities = device.entities || {};
    const rssiRaw = this._numberState(entities.rssi, null);
    const rssiBar = Number.isFinite(rssiRaw) ? this._rssiBar(rssiRaw) : "";
    const rssiLabel = Number.isFinite(rssiRaw) ? `(${rssiRaw} dBm) ${rssiBar}` : "—";
    const offsetVal = this._entityValue(entities.temp_offset);
    const waterTemp = this._entityValue(entities.current_temperature);
    const rows = [
      ["Nazwa urządzenia:", device.name],
      ["ID:", device.original_identifier || "—"],
      ["IP:", device.ip],
      ["MAC:", this._entityValue(entities.mac)],
      ["RSSI:", rssiLabel],
      ["Typ połączenia:", "Wi-Fi"],
      ["Temperatura wody:", waterTemp],
      ["Przesunięcie dla wody:", offsetVal],
      ["Wersja oprogramowania:", this._entityValue(entities.version)],
    ];
    return `
      <div class="hm-screen">
        ${this._renderHaHeader("Szczegóły urządzenia")}
        <div class="hm-card hm-list">
          ${rows.map(([label, value]) => `
            <div class="hm-setting-row">
              <span>${label}</span>
              <small class="hm-setting-value">${this._escape(String(value || "—"))}</small>
            </div>
          `).join("")}
        </div>
      </div>
    `;
  }

  _rssiBar(dbm) {
    const pct = Math.max(0, Math.min(100, ((dbm + 100) / 60) * 100));
    const bars = Math.round(pct / 20);
    return ["▁", "▂", "▄", "▆", "█"].map((b, i) => i < bars ? b : "░").join("");
  }

  async _handleHypermaxAction(action) {
    const device = this._selected;
    const entities = (device && device.entities) || {};
    const climate = this._entity(entities.thermostat);
    const currentTarget = climate && climate.attributes.temperature != null
      ? Number(climate.attributes.temperature)
      : NaN;
    const efficiencyState = this._entity(entities.filter_efficiency);
    const currentEfficiency = efficiencyState ? Number(efficiencyState.state) : NaN;

    if (action === "toggle-thermostat" && entities.thermostat) {
      await this._callService("climate", "set_hvac_mode", {
        entity_id: entities.thermostat,
        hvac_mode: climate && climate.state === "heat" ? "off" : "heat",
      });
    } else if (action === "toggle-pump" && entities.pump) {
      await this._callService("switch", this._isOn(entities.pump) ? "turn_off" : "turn_on", {
        entity_id: entities.pump,
      });
    } else if ((action === "temp-up" || action === "temp-down") && entities.thermostat && Number.isFinite(currentTarget)) {
      const next = Math.max(20, Math.min(33, Math.round((currentTarget + (action === "temp-up" ? 0.1 : -0.1)) * 10) / 10));
      await this._callService("climate", "set_temperature", {
        entity_id: entities.thermostat,
        temperature: next,
      });
    } else if ((action === "eff-up" || action === "eff-down") && entities.filter_efficiency && Number.isFinite(currentEfficiency)) {
      const next = Math.max(20, Math.min(100, currentEfficiency + (action === "eff-up" ? 1 : -1)));
      await this._callService("number", "set_value", { entity_id: entities.filter_efficiency, value: next });
    } else if (action === "toggle-notify" && entities.notify) {
      const on = this._isOn(entities.notify);

      this._optimisticSwitch = { id: entities.notify, state: on ? "off" : "on" };
      this._render();
      try {
        await this._callService("switch", on ? "turn_off" : "turn_on", { entity_id: entities.notify });
      } catch (err) {
        this._optimisticSwitch = null;
        this._showToast("Błąd zapisu: " + ((err && err.message) || err));
        this._render();
      }
    } else if (action === "notify-min-up" || action === "notify-min-down") {
      this._bumpNumber(entities.notify_min, action === "notify-min-up" ? 0.5 : -0.5, 15, 35, 20);
    } else if (action === "notify-max-up" || action === "notify-max-down") {
      this._bumpNumber(entities.notify_max, action === "notify-max-up" ? 0.5 : -0.5, 15, 35, 30);
    } else if (action === "toggle-pin") {
      const pinOn = String((device && device.pin_state) || "Off").toLowerCase() === "on";
      if (pinOn) {
        await this._setPin(false, null);
      } else {
        const input = this.shadowRoot.querySelector("[data-pin-input]");
        const code = input ? input.value.trim() : "";
        if (/^\d{6}$/.test(code)) {
          await this._setPin(true, code);
        } else {
          this._showToast("Wpisz 6-cyfrowy kod PIN, potem włącz zabezpieczenie");
          this._render();
        }
      }
    } else if (action === "save-pin") {
      const input = this.shadowRoot.querySelector("[data-pin-input]");
      const code = input ? input.value.trim() : "";
      if (/^\d{6}$/.test(code)) {
        await this._setPin(true, code);
      } else {
        this._showToast("Kod PIN musi mieć dokładnie 6 cyfr");
      }
    }
  }

  async _setSwitchEntity(entityId, on) {
    if (!entityId) {
      return;
    }
    await this._callService("switch", on ? "turn_on" : "turn_off", { entity_id: entityId });
  }

  async _setNumberEntity(entityId, value) {
    if (!entityId || !Number.isFinite(value)) {
      return;
    }
    await this._callService("number", "set_value", { entity_id: entityId, value });
  }

  async _setSelectEntity(entityId, option) {
    if (!entityId || !option) {
      return;
    }
    await this._callService("select", "select_option", { entity_id: entityId, option });
  }

  async _pressEntity(entityId) {
    if (!entityId) {
      return;
    }
    await this._callService("button", "press", { entity_id: entityId });
  }

  async _setLightChannels(entities, red, blue, white) {
    if (!entities || !entities.light) {
      return;
    }
    const to255 = (value) => Math.max(0, Math.min(255, Math.round(value * 255 / 100)));
    await this._callService("light", "turn_on", {
      entity_id: entities.light,
      rgbw_color: [to255(red), 0, to255(blue), to255(white)],
    });
  }

  async _turnLightOff(entities) {
    if (!entities || !entities.light) {
      return;
    }
    await this._callService("light", "turn_off", { entity_id: entities.light });
  }

  async _applyHypermaxTarget(entities, target, efficiency, heaterOn = true, pumpOn = true) {
    if (!entities) {
      return;
    }
    await this._setSwitchEntity(entities.pump, pumpOn);
    if (entities.thermostat) {
      await this._callService("climate", "set_hvac_mode", {
        entity_id: entities.thermostat,
        hvac_mode: heaterOn ? "heat" : "off",
      });
      if (heaterOn && Number.isFinite(target)) {
        await this._callService("climate", "set_temperature", {
          entity_id: entities.thermostat,
          temperature: target,
        });
      }
    } else {
      await this._setSwitchEntity(entities.thermostat_switch, heaterOn);
      await this._setNumberEntity(entities.target_temperature, target);
    }
    await this._setNumberEntity(entities.filter_efficiency, efficiency);
  }

  async _setSocketDayNight(entities, mode1, mode2) {
    if (!entities) {
      return;
    }
    await this._setSwitchEntity(entities.auto_mode, false);
    await this._setSelectEntity(entities.output_1_mode, mode1);
    await this._setSelectEntity(entities.output_2_mode, mode2);
  }

  async _applyLightPreset(entities, presetKey) {
    if (!entities) {
      return;
    }
    await this._setSwitchEntity(entities.auto_mode, false);
    if (entities[presetKey]) {
      await this._pressEntity(entities[presetKey]);
      return;
    }
    if (presetKey === "preset_marine") {
      await this._setLightChannels(entities, 0, 80, 70);
    } else {
      await this._setLightChannels(entities, 70, 80, 55);
    }
  }

  async _handleLightAction(action) {
    const device = this._selected && this._selected.type === "light" ? this._selected : this._deviceByType("light");
    const entities = (device && device.entities) || {};
    try {
      if (action === "off") {
        await this._turnLightOff(entities);
        this._showToast("Lampa wyłączona");
      } else {
        await this._applyLightPreset(entities, action);
        this._showToast("Preset lampy ustawiony");
      }
    } catch (err) {
      this._showToast("Błąd lampy: " + ((err && err.message) || err));
    }
    this._render();
  }

  async _handleLightChannel(channel, value) {
    const device = this._selected && this._selected.type === "light" ? this._selected : this._deviceByType("light");
    const entities = (device && device.entities) || {};
    const numberEntity = channel === "red"
      ? entities.light_red
      : channel === "blue"
        ? entities.light_blue
        : entities.light_white;
    const numeric = Math.max(0, Math.min(100, Math.round(Number(value))));
    try {
      await this._setSwitchEntity(entities.auto_mode, false);
      await this._setNumberEntity(numberEntity, numeric);
      this._showToast("Kanał " + channel + " ustawiony na " + numeric + "%");
    } catch (err) {
      this._showToast("Błąd lampy: " + ((err && err.message) || err));
    }
    this._render();
  }

  async _handleSocketMode(action) {
    const device = this._selected && this._selected.type === "socket" ? this._selected : this._deviceByType("socket");
    const entities = (device && device.entities) || {};
    const [ch, cmd] = String(action || "").split(":");
    const switchEntity = ch === "1" ? entities.output_1 : entities.output_2;
    const modeEntity = ch === "1" ? entities.output_1_mode : entities.output_2_mode;
    try {
      if (cmd === "toggle") {
        if (switchEntity) {
          await this._callService("switch", this._isOn(switchEntity) ? "turn_off" : "turn_on", { entity_id: switchEntity });
        }
      } else {
        if (switchEntity) {
          await this._callService("switch", "turn_on", { entity_id: switchEntity });
        }
        if (modeEntity) {
          await this._setSelectEntity(modeEntity, cmd);
        }
        this._showToast("Kanał " + ch + ": " + cmd);
      }
    } catch (err) {
      this._showToast("Błąd socketu: " + ((err && err.message) || err));
    }
    this._render();
  }

  async _setPin(enabled, code) {
    const device = this._selected;
    if (!device || !this._hass) {
      return;
    }
    try {
      const payload = { type: "aquael_link/set_pin", entry_id: device.entry_id, enabled };
      if (code) {
        payload.code = code;
      }
      const response = await this._hass.callWS(payload);
      if (!response || response.success !== true) {
        throw new Error("urządzenie nie potwierdziło zapisu");
      }
      device.pin_state = enabled ? "On" : "Off";
      device.pin_code = enabled && code ? code : 0;
      this._showToast(enabled ? "Kod PIN zapisany" : "Zabezpieczenie wyłączone");
    } catch (err) {
      this._showToast("Błąd zapisu PIN: " + ((err && err.message) || err));
    }
    this._render();
  }

  async _renameDevice() {
    const device = this._selected;
    const entities = (device && device.entities) || {};
    if (!entities.name) {
      this._showToast("Brak encji nazwy — przeładuj integrację");
      return;
    }
    const current = device.name || "";
    const value = prompt("Nowa nazwa urządzenia:", current);
    if (value == null) {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed || trimmed === current) {
      return;
    }
    try {
      await this._callService("text", "set_value", { entity_id: entities.name, value: trimmed });
      device.name = trimmed;
      this._showToast("Nazwa zmieniona na „" + trimmed + "”");
    } catch (err) {
      this._showToast("Błąd zmiany nazwy: " + ((err && err.message) || err));
    }
    this._render();
  }

  _showToast(message) {
    const el = this.shadowRoot && this.shadowRoot.querySelector(".aq-toast");
    if (!el) {
      return;
    }
    el.textContent = message;
    el.classList.add("visible");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove("visible"), 3500);
  }

  _renderMain() {
    if (!this._selected) {
      return `<div class="empty">Brak urządzeń dodanych do panelu Aquael Link.</div>`;
    }
    const cockpit = this._renderAquariumCockpit();
    let body = "";
    if (this._selected.type === "hypermax") {
      body = this._renderHypermax(this._selected);
    } else if (this._selected.type === "light") {
      body = this._renderLightPanel(this._selected);
    } else if (this._selected.type === "socket") {
      body = this._renderSocketPanel(this._selected);
    } else if (this._selected.chart_url) {
      const token = (this._hass && this._hass.auth && this._hass.auth.data && this._hass.auth.data.access_token) || "";
      const url = `${this._selected.chart_url}#${new URLSearchParams({ token }).toString()}`;
      body = `<iframe title="${this._escape(this._selected.name)}" src="${this._escape(url)}"></iframe>`;
    } else {
      body = `<div class="empty">Brak widoku panelu dla tego urządzenia.</div>`;
    }
    return `${cockpit}<div class="device-detail">${body}</div>`;
  }

  _renderLightPanel(device) {
    const entities = device.entities || {};
    const red = this._numberState(entities.light_red, NaN);
    const blue = this._numberState(entities.light_blue, NaN);
    const white = this._numberState(entities.light_white, NaN);
    const on = this._entity(entities.light);
    return `
      <section class="hm-screen">
        <div class="hm-card aq-device-panel">
          <div class="aq-device-panel__media"><img src="${PANEL_STATIC_URL}/ios-light.png" alt=""></div>
          <div class="aq-device-panel__body">
            <h3>${this._escape(device.name || "LEDDY Slim Link")}</h3>
            <p>${on && on.state === "on" ? "Światło aktywne" : "Światło wyłączone"} · R ${this._formatPct(red)} · B ${this._formatPct(blue)} · W ${this._formatPct(white)}</p>
            <div class="aq-inline-actions">
              <button data-aq-light="preset_plant"><ha-icon icon="mdi:leaf"></ha-icon>Plant</button>
              <button data-aq-light="preset_sunny"><ha-icon icon="mdi:white-balance-sunny"></ha-icon>Sunny</button>
              <button data-aq-light="preset_marine"><ha-icon icon="mdi:waves"></ha-icon>Marine</button>
              <button data-aq-light="off"><ha-icon icon="mdi:power"></ha-icon>Off</button>
            </div>
            <div class="aq-channel-board">
              ${this._renderLightChannelSlider("red", "Czerwony", "mdi:circle", red)}
              ${this._renderLightChannelSlider("blue", "Niebieski", "mdi:circle", blue)}
              ${this._renderLightChannelSlider("white", "Biały", "mdi:white-balance-sunny", white)}
            </div>
          </div>
        </div>
      </section>
    `;
  }

  _renderLightChannelSlider(channel, label, icon, value) {
    const safe = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
    return `
      <label class="aq-channel aq-channel--${this._escape(channel)}">
        <span>
          <ha-icon icon="${this._escape(icon)}"></ha-icon>
          <b>${this._escape(label)}</b>
        </span>
        <input type="range" min="0" max="100" step="1" value="${safe}" data-aq-light-channel="${this._escape(channel)}">
        <strong data-aq-light-value="${this._escape(channel)}">${safe}%</strong>
      </label>
    `;
  }

  _renderSocketPanel(device) {
    const entities = device.entities || {};
    const ch1On = this._isOn(entities.output_1);
    const ch2On = this._isOn(entities.output_2);
    const ch1Mode = this._socketModeLabel(entities.output_1_mode);
    const ch2Mode = this._socketModeLabel(entities.output_2_mode);
    const renderChannel = (ch, isOn, mode) => `
      <div class="aq-socket-channel">
        <div class="aq-socket-ch-head">
          <span>Kanał ${ch}</span>
          <button class="aq-socket-toggle ${isOn ? "active" : ""}" data-aq-socket="${ch}:toggle">
            <ha-icon icon="mdi:power"></ha-icon>${isOn ? "On" : "Off"}
          </button>
        </div>
        ${isOn ? `
        <div class="aq-ctrl-btns">
          <button data-aq-socket="${ch}:Swit"><ha-icon icon="mdi:weather-sunset-up"></ha-icon>Daybreak</button>
          <button data-aq-socket="${ch}:Dzien"><ha-icon icon="mdi:white-balance-sunny"></ha-icon>Day</button>
          <button data-aq-socket="${ch}:Noc"><ha-icon icon="mdi:weather-night"></ha-icon>Night</button>
        </div>
        <p class="aq-socket-mode-label">aktywny tryb: <strong>${this._escape(mode)}</strong></p>
        ` : ""}
      </div>
    `;
    return `
      <section class="hm-screen">
        <div class="hm-card aq-device-panel">
          <div class="aq-device-panel__media"><img src="${PANEL_STATIC_URL}/ios-socket-duo.png" alt=""></div>
          <div class="aq-device-panel__body">
            <h3>${this._escape(device.name || "Socket Duo Link")}</h3>
            ${renderChannel(1, ch1On, ch1Mode)}
            ${renderChannel(2, ch2On, ch2Mode)}
          </div>
        </div>
      </section>
    `;
  }

  _render() {
    if (!this.shadowRoot) {
      return;
    }
    const sel = this._selected;
    const selMode = sel && this._hypermaxModes ? this._hypermaxModes[sel.entry_id] : null;
    this._iframeMode = !!(sel && (
      (sel.type === "hypermax" && (selMode === "flow" || selMode === "thermostat" || selMode === "chart")) ||
      sel.type === "thermometer"
    ));
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          min-height: 100%;
          color: var(--primary-text-color);
          background: var(--primary-background-color);
        }
        .shell {
          display: grid;
          grid-template-columns: minmax(220px, 280px) 1fr;
          min-height: calc(100vh - var(--header-height, 56px));
        }
        aside {
          border-right: 1px solid var(--divider-color);
          background: var(--card-background-color);
          padding: 12px;
        }
        h1 {
          font-size: 18px;
          font-weight: 600;
          margin: 4px 4px 12px;
        }
        .tile {
          width: 100%;
          min-height: 58px;
          border: 1px solid var(--divider-color);
          border-radius: 8px;
          background: var(--card-background-color);
          color: var(--primary-text-color);
          display: grid;
          grid-template-columns: 36px 1fr;
          gap: 10px;
          align-items: center;
          text-align: left;
          padding: 10px;
          cursor: pointer;
          margin-bottom: 8px;
        }
        .tile.selected {
          border-color: var(--primary-color);
          box-shadow: inset 3px 0 0 var(--primary-color);
        }
        .tile ha-icon {
          color: var(--primary-color);
        }
        .tile-thumb {
          width: 34px;
          height: 34px;
          object-fit: contain;
          display: block;
          justify-self: center;
          filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.35)) brightness(1.12);
        }
        .tile-thumb--thermometer {
          width: 24px;
          height: 42px;
        }
        .tile-thumb--hypermax {
          width: 38px;
          height: 34px;
        }
        .tile strong,
        .tile small {
          display: block;
          overflow-wrap: anywhere;
        }
        .tile small {
          color: var(--secondary-text-color);
          margin-top: 2px;
        }
        main {
          min-width: 0;
          min-height: 100%;
          padding: 16px;
          box-sizing: border-box;
        }
        iframe {
          border: 0;
          width: 100%;
          height: calc(100vh - var(--header-height, 56px));
          background: white;
        }
        .device-detail {
          margin-top: 16px;
        }
        .device-detail > iframe,
        .device-detail > .hypermax-shell {
          border-radius: 8px;
          overflow: hidden;
          border: 1px solid var(--divider-color);
        }
        .aquarium-card {
          position: relative;
          overflow: hidden;
          border: 1px solid var(--divider-color);
          border-radius: 8px;
          background:
            linear-gradient(135deg, rgba(12, 75, 91, 0.10), rgba(62, 126, 92, 0.08) 44%, rgba(243, 167, 65, 0.10)),
            var(--card-background-color);
          box-shadow: var(--ha-card-box-shadow, none);
        }
        .aq-metrics {
          display: grid;
          grid-template-columns: repeat(6, minmax(0, 1fr));
          gap: 1px;
          border-top: 1px solid var(--divider-color);
          border-bottom: 1px solid var(--divider-color);
          background: var(--divider-color);
        }
        .aq-metric {
          min-width: 0;
          padding: 14px 12px;
          background: var(--card-background-color);
        }
        .aq-metric span,
        .aq-metric small {
          display: block;
          overflow-wrap: anywhere;
        }
        .aq-metric span {
          color: var(--secondary-text-color);
          font-size: 12px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .aq-metric strong {
          display: block;
          margin-top: 5px;
          font-size: 24px;
          line-height: 1.05;
          color: var(--primary-text-color);
        }
        .aq-metric small {
          margin-top: 5px;
          color: var(--secondary-text-color);
          font-size: 12px;
          line-height: 1.25;
        }
        .aq-metric.ok strong { color: #2e7d32; }
        .aq-metric.cold strong { color: #0277bd; }
        .aq-metric.warm strong { color: #d84315; }
        .aq-socket-channel { margin-top: 8px; }
        .aq-socket-ch-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 6px;
        }
        .aq-socket-ch-head span { font-size: 13px; font-weight: 600; }
        .aq-socket-toggle {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 3px 10px;
          border-radius: 6px;
          border: 1px solid var(--divider-color);
          background: var(--card-background-color);
          color: var(--primary-text-color);
          font: inherit;
          font-size: 12px;
          cursor: pointer;
        }
        .aq-socket-toggle.active {
          background: var(--primary-color);
          color: #fff;
          border-color: var(--primary-color);
        }
        .aq-socket-toggle ha-icon { --mdc-icon-size: 14px; }
        .aq-socket-mode-label { font-size: 12px; color: var(--secondary-text-color); margin: 4px 0 0; }
        .aq-card-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px 16px;
        }
        .aq-card-header strong {
          font-size: 11px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--secondary-text-color);
        }
        .aq-photo-controls {
          display: flex;
          gap: 6px;
        }
        .aq-photo-btn {
          width: 30px;
          height: 30px;
          border: 1px solid var(--divider-color);
          border-radius: 6px;
          background: transparent;
          color: var(--secondary-text-color);
          cursor: pointer;
          display: grid;
          place-items: center;
          --mdc-icon-size: 17px;
        }
        .aq-photo-btn input { display: none; }
        .aq-photo-btn:hover { color: var(--primary-color); border-color: var(--primary-color); }
        .aq-tank-strip {
          width: 100%;
          height: 150px;
          overflow: hidden;
          border-bottom: 1px solid var(--divider-color);
        }
        .aq-tank-strip img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }
        .aq-controls {
          display: flex;
          flex-wrap: wrap;
          gap: 1px;
          background: var(--divider-color);
        }
        .aq-ctrl-group {
          flex: 1 1 200px;
          min-width: 0;
          background: var(--card-background-color);
          padding: 14px 16px;
        }
        .aq-ctrl-label {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: var(--secondary-text-color);
          margin-bottom: 10px;
        }
        .aq-ctrl-label ha-icon { --mdc-icon-size: 15px; color: var(--primary-color); }
        .aq-ctrl-btns {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .aq-ctrl-btns button {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 0 12px;
          min-height: 34px;
          border: 1px solid var(--divider-color);
          border-radius: 6px;
          background: var(--card-background-color);
          color: var(--primary-text-color);
          font: inherit;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        }
        .aq-ctrl-btns button:hover {
          border-color: var(--primary-color);
          color: var(--primary-color);
          box-shadow: inset 0 0 0 1px var(--primary-color);
        }
        .aq-ctrl-btns ha-icon { --mdc-icon-size: 15px; color: var(--primary-color); }
        .aq-device-panel {
          display: grid;
          grid-template-columns: 120px 1fr;
          gap: 18px;
          padding: 18px;
          align-items: center;
        }
        .aq-device-panel__media {
          display: grid;
          place-items: center;
          min-height: 120px;
        }
        .aq-device-panel__media img {
          max-width: 110px;
          max-height: 110px;
          object-fit: contain;
        }
        .aq-device-panel__body h3 {
          margin: 0 0 6px;
          font-size: 22px;
          line-height: 1.15;
        }
        .aq-device-panel__body p {
          margin: 0 0 14px;
          color: var(--secondary-text-color);
        }
        .aq-inline-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        .aq-inline-actions button {
          min-height: 38px;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 0 12px;
          font-weight: 700;
        }
        .aq-inline-actions ha-icon {
          --mdc-icon-size: 18px;
          color: var(--primary-color);
        }
        .aq-channel-board {
          display: grid;
          gap: 10px;
          margin-top: 16px;
        }
        .aq-channel {
          display: grid;
          grid-template-columns: 120px minmax(120px, 1fr) 56px;
          align-items: center;
          gap: 12px;
          padding: 12px;
          border: 1px solid var(--divider-color);
          border-radius: 8px;
          background: rgba(127, 127, 127, 0.06);
        }
        .aq-channel span {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
          font-weight: 700;
        }
        .aq-channel ha-icon {
          --mdc-icon-size: 18px;
        }
        .aq-channel--red ha-icon { color: #d32f2f; }
        .aq-channel--blue ha-icon { color: #1976d2; }
        .aq-channel--white ha-icon { color: #f9a825; }
        .aq-channel input[type="range"] {
          width: 100%;
          accent-color: var(--primary-color);
        }
        .aq-channel strong {
          text-align: right;
          font-size: 15px;
        }
        .hypermax-shell {
          min-height: calc(100vh - var(--header-height, 56px));
          background: var(--primary-background-color);
        }
        .hm-screen {
          max-width: 760px;
          margin: 0 auto;
          padding: 16px 16px 32px;
          box-sizing: border-box;
          color: var(--primary-text-color);
        }
        .hm-topbar {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 4px 0 16px;
        }
        .hm-topbar strong {
          font-size: 20px;
          font-weight: 500;
        }
        .hm-icon-btn {
          width: 40px;
          height: 40px;
          flex: none;
          border: 0;
          border-radius: 50%;
          background: transparent;
          color: var(--primary-text-color);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .hm-icon-btn:hover {
          background: var(--secondary-background-color, rgba(127,127,127,0.15));
        }
        .hm-card {
          background: var(--card-background-color);
          border-radius: var(--ha-card-border-radius, 12px);
          border: 1px solid var(--divider-color);
          box-shadow: var(--ha-card-box-shadow, none);
          overflow: hidden;
        }
        .hm-device-card {
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 16px;
          margin-bottom: 16px;
        }
        .hm-device-card img {
          width: 72px;
          max-height: 84px;
          object-fit: contain;
          flex: none;
        }
        .hm-device-info {
          flex: 1;
          min-width: 0;
        }
        .hm-device-name {
          display: block;
          border: 0;
          background: transparent;
          color: var(--primary-text-color);
          font-size: 22px;
          font-weight: 500;
          padding: 0;
          cursor: pointer;
          text-align: left;
          overflow-wrap: anywhere;
        }
        .hm-device-name:hover {
          text-decoration: underline;
        }
        .hm-device-info > span {
          display: block;
          margin-top: 2px;
          color: var(--secondary-text-color);
          font-size: 13px;
        }
        .hm-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-top: 10px;
        }
        .hm-chip {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 3px 10px;
          border-radius: 999px;
          font-size: 12px;
          background: var(--secondary-background-color, rgba(127,127,127,0.12));
          color: var(--secondary-text-color);
        }
        .hm-chip.on {
          background: rgba(var(--rgb-primary-color, 3, 169, 244), 0.15);
          color: var(--primary-color);
        }
        .hm-chip ha-icon {
          --mdc-icon-size: 14px;
        }
        .hm-menu {
          padding: 4px 0;
        }
        .hm-row {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 14px;
          padding: 12px 16px;
          border: 0;
          background: transparent;
          color: var(--primary-text-color);
          text-align: left;
          cursor: pointer;
          font: inherit;
        }
        .hm-row:hover {
          background: var(--secondary-background-color, rgba(127,127,127,0.08));
        }
        .hm-row + .hm-row {
          border-top: 1px solid var(--divider-color);
        }
        .hm-row-icon {
          width: 40px;
          height: 40px;
          flex: none;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(var(--rgb-primary-color, 3, 169, 244), 0.12);
          color: var(--primary-color);
        }
        .hm-row-text {
          flex: 1;
          min-width: 0;
        }
        .hm-row-text strong {
          display: block;
          font-size: 15px;
          font-weight: 500;
        }
        .hm-row-text small {
          display: block;
          margin-top: 2px;
          font-size: 13px;
          color: var(--secondary-text-color);
        }
        .hm-chevron {
          flex: none;
          color: var(--secondary-text-color);
        }
        .hm-list {
          padding: 4px 0;
        }
        .hm-section-title {
          padding: 14px 16px 4px;
          font-size: 12px;
          font-weight: 500;
          color: var(--secondary-text-color);
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        .hm-setting-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 12px 16px;
          font-size: 14px;
        }
        .hm-setting-row + .hm-setting-row {
          border-top: 1px solid var(--divider-color);
        }
        .hm-setting-row > span {
          flex: 1;
        }
        .hm-setting-value {
          color: var(--secondary-text-color);
          font-size: 13px;
          text-align: right;
          word-break: break-all;
        }
        .hm-stepper {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: none;
        }
        .hm-stepper button {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          border: 1px solid var(--divider-color);
          background: var(--card-background-color);
          color: var(--primary-color);
          font-size: 18px;
          font-weight: 600;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .hm-stepper button:hover {
          background: rgba(var(--rgb-primary-color, 3, 169, 244), 0.12);
        }
        .hm-stepper b {
          min-width: 56px;
          text-align: center;
          font-size: 14px;
          font-weight: 500;
        }
        .hm-toggle {
          position: relative;
          flex: none;
          width: 48px;
          height: 28px;
        }
        .hm-toggle input {
          position: absolute;
          inset: 0;
          opacity: 0;
          margin: 0;
          cursor: pointer;
          z-index: 2;
        }
        .hm-toggle i {
          display: block;
          width: 100%;
          height: 100%;
          border-radius: 999px;
          background: var(--disabled-color, #9e9e9e);
          opacity: 0.6;
          transition: background 0.2s, opacity 0.2s;
        }
        .hm-toggle i:before {
          content: "";
          position: absolute;
          top: 3px;
          left: 3px;
          width: 22px;
          height: 22px;
          border-radius: 50%;
          background: #ffffff;
          box-shadow: 0 1px 3px rgba(0,0,0,0.3);
          transition: left 0.2s;
        }
        .hm-toggle.on i {
          background: var(--primary-color);
          opacity: 1;
        }
        .hm-toggle.on i:before {
          left: 23px;
        }
        .hm-offset-row input[type="range"] {
          flex: 1;
          accent-color: var(--primary-color);
          height: 28px;
        }
        .hm-offset-value {
          flex: none;
          min-width: 64px;
          text-align: right;
          font-size: 15px;
          font-weight: 500;
        }
        .hm-pin-input {
          flex: none;
          width: 130px;
          padding: 8px 12px;
          border: 1px solid var(--divider-color);
          border-radius: 8px;
          font-size: 15px;
          text-align: right;
          background: var(--card-background-color);
          color: var(--primary-text-color);
        }
        .hm-pin-input:focus {
          outline: none;
          border-color: var(--primary-color);
        }
        .hm-setting-row--actions {
          justify-content: flex-end;
        }
        .hm-save-btn {
          border: 0;
          border-radius: 999px;
          padding: 9px 28px;
          background: var(--primary-color);
          color: var(--text-primary-color, #ffffff);
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
        }
        .hm-save-btn:hover {
          opacity: 0.9;
        }
        .ios-screen {
          --ios-green: #9fc24a;
          --ios-dark-green: #4b5f2c;
          position: relative;
          min-height: calc(100vh - var(--header-height, 56px));
          box-sizing: border-box;
          overflow: hidden;
          color: #172317;
          background: #ffffff;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .ios-control-screen {
          background: var(--primary-background-color);
        }
        .ios-header {
          height: 156px;
          box-sizing: border-box;
          display: grid;
          grid-template-columns: 112px 1fr 112px;
          align-items: center;
          padding: 28px 30px 0;
          background: var(--ios-green);
          border-bottom: 1px solid rgba(40, 62, 18, 0.22);
          color: #000000;
        }
        .ios-header strong {
          text-align: center;
          font-size: clamp(24px, 3vw, 34px);
          font-weight: 800;
          letter-spacing: 0;
        }
        .ios-back {
          width: 76px;
          height: 76px;
          border: 0;
          border-radius: 50%;
          position: relative;
          background: rgba(255,255,255,0.75);
          box-shadow: 0 2px 8px rgba(0,0,0,0.18);
        }
        .ios-back:before {
          content: "";
          position: absolute;
          left: 30px;
          top: 23px;
          width: 24px;
          height: 24px;
          border-left: 7px solid #101510;
          border-bottom: 7px solid #101510;
          transform: rotate(45deg);
        }
        .ios-back--float {
          position: absolute;
          top: 16px;
          left: 16px;
          z-index: 10;
        }
        .ios-control-body {
          position: relative;
          min-height: calc(100vh - var(--header-height, 56px) - 264px);
          padding: 56px 30px 34px;
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          background-image: url("${PANEL_STATIC_URL}/ios-background.jpg");
          background-size: cover;
          background-position: center;
        }
        .ios-toggle {
          align-self: flex-end;
          width: 178px;
          height: 86px;
          border-radius: 999px;
          position: relative;
          display: flex;
          align-items: center;
          padding-left: 42px;
          box-sizing: border-box;
          color: #ffffff;
          background: linear-gradient(#819b3e, #a8c34f);
          box-shadow: 0 12px 16px rgba(0,0,0,0.16);
        }
        .ios-toggle input {
          position: absolute;
          inset: 0;
          opacity: 0;
          z-index: 3;
        }
        .ios-toggle span {
          font-size: 30px;
          font-weight: 900;
          text-shadow: 0 2px 4px rgba(0,0,0,0.35);
        }
        .ios-toggle i {
          position: absolute;
          right: -5px;
          top: -10px;
          width: 88px;
          height: 88px;
          border-radius: 50%;
          background: radial-gradient(circle at 55% 45%, #ededed 0 27%, #dedede 29% 46%, #f8f8f8 47% 100%);
          border: 8px solid #ffffff;
          box-shadow: 0 6px 10px rgba(0,0,0,0.22);
        }
        .ios-toggle:not(.on) {
          padding-left: 82px;
          background: linear-gradient(#777777, #a3a3a3);
        }
        .ios-toggle:not(.on) i {
          left: -5px;
          right: auto;
        }
        .ios-alerts {
          min-height: 126px;
          margin-top: 56px;
          color: #ff3328;
          font-size: clamp(24px, 3.4vw, 39px);
          line-height: 1.22;
          font-weight: 800;
        }
        .ios-alerts p {
          display: none;
          margin: 0 0 36px;
        }
        .ios-alerts p.visible {
          display: block;
        }
        .ios-label {
          margin-top: 26px;
          color: #4d5b4e;
          font-size: clamp(26px, 4vw, 42px);
          font-weight: 900;
          letter-spacing: 0;
        }
        .ios-value {
          margin-top: 18px;
          color: rgba(26, 38, 26, 0.58);
          font-size: clamp(92px, 15vw, 142px);
          line-height: 0.95;
          font-weight: 300;
        }
        .ios-value sup {
          font-size: 0.32em;
          vertical-align: super;
        }
        .hypermax-frame {
          flex: 1;
          width: 100%;
          border: 0;
          background: transparent;
          min-height: 540px;
        }
        .hypermax-frame--phone {
          display: block;
          width: min(460px, 100%);
          height: min(820px, calc(100vh - var(--header-height, 56px)));
          min-height: 0;
          background: #ffffff;
          margin: 0 auto;
        }
        .ios-slider {
          width: min(72%, 520px);
          height: 102px;
          margin-top: 62px;
          border-radius: 999px;
          display: grid;
          grid-template-columns: 96px 1fr 96px;
          align-items: center;
          background: rgba(210, 208, 213, 0.9);
        }
        .ios-slider button {
          border: 0;
          height: 100%;
          color: #464646;
          background: transparent;
          font-size: 46px;
        }
        .ios-slider div {
          position: relative;
          height: 100%;
        }
        .ios-slider i {
          position: absolute;
          left: var(--pos);
          top: 50%;
          width: 104px;
          height: 104px;
          border-radius: 50%;
          transform: translate(calc(-50% + var(--drag, 0px)), -50%);
          transition: transform 0.45s cubic-bezier(0.175,0.885,0.32,1.275);
          background: linear-gradient(#fbfbfb 0%, #eeeeee 42%, #d9d9d9 100%);
          box-shadow: 0 8px 16px rgba(0,0,0,0.18);
          cursor: grab;
          touch-action: none;
          display: flex;
          align-items: center;
          justify-content: center;
          font-style: normal;
          font-weight: 800;
          font-size: 34px;
          color: #2a2a2a;
          user-select: none;
        }
        .ios-slider.is-dragging i { transition: none; cursor: grabbing; }
        .ios-drag {
          max-width: min(84%, 760px);
          margin-top: 58px;
          color: #4d5b4e;
          font-size: clamp(22px, 3.2vw, 34px);
          line-height: 1.25;
          font-weight: 800;
        }
        .ios-current {
          margin-top: 42px;
          color: #172317;
          font-size: clamp(30px, 4vw, 45px);
          font-weight: 400;
        }
        .ios-heating {
          position: absolute;
          left: 40px;
          top: 44px;
          width: 20px;
          height: 20px;
          border-radius: 50%;
          display: none;
          border: 2px solid #000000;
          background: #ff0000;
        }
        .ios-heating.visible {
          display: block;
        }
        .ios-scrollable {
          overflow-y: auto !important;
        }
        .hypermax-frame--full {
          display: block;
          width: 100%;
          height: calc(100vh - var(--header-height, 56px));
          min-height: 540px;
          background: #ffffff;
        }
        .aq-toast {
          position: fixed;
          left: 50%;
          bottom: 32px;
          transform: translateX(-50%);
          max-width: 80vw;
          padding: 12px 24px;
          border-radius: 999px;
          background: rgba(20, 30, 12, 0.92);
          color: #ffffff;
          font-size: 15px;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.25s;
          z-index: 99;
        }
        .aq-toast.visible {
          opacity: 1;
        }
        .ios-settings-list {
          padding: 0 !important;
        }
        .ios-section-title {
          padding: 10px 24px 4px;
          font-size: 13px;
          color: #888;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .ios-setting-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px 24px;
          border-bottom: 1px solid #e8e8e8;
          font-size: 16px;
          gap: 12px;
        }
        .ios-setting-row span { flex: 1; }
        .ios-setting-value {
          color: #888;
          font-size: 14px;
          text-align: right;
          word-break: break-all;
        }
        .ios-stepper {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .ios-stepper button {
          width: 36px;
          height: 36px;
          border-radius: 50%;
          border: 0;
          background: var(--ios-green);
          font-size: 22px;
          font-weight: 700;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .ios-stepper b { font-size: 16px; min-width: 48px; text-align: center; }
        .ios-stepper--wide b { min-width: 80px; font-size: 22px; }
        .ios-tabbar {
          position: absolute;
          left: 0;
          right: 0;
          bottom: 0;
          height: 108px;
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          align-items: center;
          background: var(--ios-green);
          color: #000000;
        }
        .ios-tabbar span {
          min-width: 0;
          height: 76px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 5px;
          font-size: 20px;
        }
        .ios-tabbar span.active {
          width: 170px;
          justify-self: center;
          border-radius: 999px;
          color: rgba(255,255,255,0.55);
          background: #80a82a;
        }
        .ios-tabbar img {
          width: 38px;
          height: 38px;
          object-fit: contain;
        }
        .ios-device-card {
          min-height: 170px;
          display: grid;
          grid-template-columns: 150px 1fr 80px;
          align-items: center;
          gap: 18px;
          padding: 24px 38px;
          border-top: 1px solid #e3e3e3;
          border-bottom: 1px solid #e3e3e3;
          color: var(--ios-dark-green);
          background: #ffffff;
        }
        .ios-device-card img {
          width: 112px;
          max-height: 120px;
          object-fit: contain;
        }
        .ios-device-card strong,
        .ios-device-card span {
          display: block;
        }
        .ios-device-card strong {
          font-size: clamp(28px, 4vw, 42px);
          line-height: 1.05;
        }
        .ios-device-card span {
          margin-top: 8px;
          font-size: clamp(18px, 2.6vw, 27px);
        }
        .ios-device-card ha-icon,
        .ios-menu-list ha-icon {
          color: #8c8e92;
          --mdc-icon-size: 40px;
        }
        .ios-menu-list {
          padding: 42px 38px 0;
          background: #ffffff;
        }
        .ios-menu-list button {
          width: 100%;
          min-height: 108px;
          border: 0;
          border-bottom: 1px solid #dedede;
          display: grid;
          grid-template-columns: 1fr 72px;
          align-items: center;
          gap: 16px;
          text-align: left;
          color: var(--ios-dark-green);
          background: #ffffff;
        }
        .ios-menu-list strong,
        .ios-menu-list small {
          display: block;
        }
        .ios-menu-list strong {
          font-size: clamp(26px, 3.6vw, 38px);
          font-weight: 400;
        }
        .ios-menu-list small {
          margin-top: 8px;
          font-size: clamp(18px, 2.7vw, 28px);
        }
        .ios-menu-screen {
          background: linear-gradient(#f2f3f6 156px, #ffffff 156px);
        }
        .empty,
        .error {
          padding: 24px;
          color: var(--secondary-text-color);
        }
        @media (max-width: 1180px) {
          .aq-metrics {
            grid-template-columns: repeat(3, minmax(0, 1fr));
          }
        }
        @media (max-width: 720px) {
          .shell {
            grid-template-columns: 1fr;
          }
          main {
            padding: 12px;
          }
          .aq-metrics {
            grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
          }
          .aq-metric strong {
            font-size: 21px;
          }
          .aq-device-panel {
            grid-template-columns: 1fr;
          }
          .aq-channel {
            grid-template-columns: 1fr;
          }
          .aq-channel strong {
            text-align: left;
          }
          aside {
            border-right: 0;
            border-bottom: 1px solid var(--divider-color);
          }
          iframe {
            height: calc(100vh - var(--header-height, 56px) - 120px);
          }
          .hypermax-frame--phone {
            height: min(820px, calc(100vh - var(--header-height, 56px) - 120px));
            min-height: 0;
          }
          .hypermax-shell {
            padding: 12px;
          }
        }
      </style>
      <div class="shell">
        <aside>
          <h1>Aquael Link</h1>
          <div style="font-size:11px;color:#8a8;margin:-6px 0 10px;font-weight:700;">wersja: ${PANEL_VERSION}</div>
          ${this._error ? `<div class="error">${this._escape(this._error)}</div>` : this._devices.map((device) => this._renderDeviceButton(device)).join("")}
        </aside>
        <main>${this._renderMain()}</main>
      </div>
      <div class="aq-toast"></div>
    `;
    this._lastSig = this._stateSignature();
    for (const button of this.shadowRoot.querySelectorAll(".tile")) {
      button.addEventListener("click", () => {
        const device = this._devices.find((item) => item.entry_id === button.dataset.entryId);
        if (device) {
          this._selectDevice(device);
        }
      });
    }
    for (const button of this.shadowRoot.querySelectorAll("[data-mode]")) {
      button.addEventListener("click", () => {
        if (this._selected) {
          this._setHypermaxMode(this._selected.entry_id, button.dataset.mode);
        }
      });
    }
    for (const button of this.shadowRoot.querySelectorAll("[data-action]")) {
      button.addEventListener("click", () => {
        this._handleHypermaxAction(button.dataset.action);
      });
    }
    const tankPhotoInput = this.shadowRoot.querySelector("[data-aq-photo-input]");
    if (tankPhotoInput) {
      tankPhotoInput.addEventListener("change", async () => {
        const file = tankPhotoInput.files && tankPhotoInput.files[0];
        if (!file) {
          return;
        }
        try {
          const dataUrl = await this._resizeTankPhoto(file);
          this._saveTankPhoto(dataUrl);
          this._showToast("Zdjęcie akwarium dodane");
          this._render();
        } catch (err) {
          this._showToast(err && err.message ? err.message : "Nie udało się dodać zdjęcia");
        } finally {
          tankPhotoInput.value = "";
        }
      });
    }
    const tankPhotoClear = this.shadowRoot.querySelector("[data-aq-photo-clear]");
    if (tankPhotoClear) {
      tankPhotoClear.addEventListener("click", () => {
        this._saveTankPhoto("");
        this._showToast("Zdjęcie akwarium usunięte");
        this._render();
      });
    }
    for (const button of this.shadowRoot.querySelectorAll("[data-aq-light]")) {
      button.addEventListener("click", () => {
        this._handleLightAction(button.dataset.aqLight);
      });
    }
    for (const button of this.shadowRoot.querySelectorAll("[data-aq-socket]")) {
      button.addEventListener("click", () => {
        this._handleSocketMode(button.dataset.aqSocket);
      });
    }
    for (const slider of this.shadowRoot.querySelectorAll("[data-aq-light-channel]")) {
      const channel = slider.dataset.aqLightChannel;
      const label = this.shadowRoot.querySelector(`[data-aq-light-value="${channel}"]`);
      slider.addEventListener("input", () => {
        this._dragging = true;
        if (label) {
          label.textContent = Math.round(Number(slider.value)) + "%";
        }
      });
      slider.addEventListener("change", async () => {
        this._dragging = false;
        await this._handleLightChannel(channel, slider.value);
      });
    }
    for (const button of this.shadowRoot.querySelectorAll("[data-rename]")) {
      button.addEventListener("click", () => {
        this._renameDevice();
      });
    }
    const offsetSlider = this.shadowRoot.querySelector("[data-offset-slider]");
    if (offsetSlider) {
      const label = this.shadowRoot.querySelector(".hm-offset-value");
      offsetSlider.addEventListener("input", () => {
        this._dragging = true;
        if (label) {
          label.textContent = Number(offsetSlider.value).toFixed(1) + "°C";
        }
      });
      offsetSlider.addEventListener("change", async () => {
        this._dragging = false;
        const entities = (this._selected && this._selected.entities) || {};
        if (entities.temp_offset) {
          await this._callService("number", "set_value", {
            entity_id: entities.temp_offset,
            value: Math.round(Number(offsetSlider.value) * 10) / 10,
          });
        }
      });
    }
    this._attachKnobs();
  }

  _attachKnobs() {
    const PARAMS = {
      temp: { list: [{ t: 30, v: 0.1 }, { t: 100, v: 1 }], timerStep: 5, interval: 1000, round: (x) => Math.round(x * 10) / 10 },
      eff:  { list: [{ t: 30, v: 1 }, { t: 100, v: 10 }], timerStep: 5, interval: 1000, round: (x) => Math.round(x) },
    };
    for (const slider of this.shadowRoot.querySelectorAll(".ios-slider[data-knob]")) {
      const handle = slider.querySelector("[data-knob-handle]");
      if (!handle) continue;
      let cfg;
      try { cfg = JSON.parse(slider.dataset.knob); } catch (err) { continue; }
      const p = PARAMS[cfg.kind] || PARAMS.eff;
      const valEl = handle.querySelector("b");
      let dragging = false, startX = 0, half = 1, delta = 0, lastPos = 0, timer = null;
      const clampDelta = () => {
        if (cfg.base + delta > cfg.max) delta = cfg.max - cfg.base;
        if (cfg.base + delta < cfg.min) delta = cfg.min - cfg.base;
      };
      const show = () => { if (valEl) valEl.textContent = p.round(cfg.base + delta); };
      const thr = (posPct) => {
        const avail = p.list.filter((x) => x.t <= Math.abs(Math.round(posPct)));
        const v = avail.length ? avail[avail.length - 1].v : 0;
        return posPct >= 0 ? v : -v;
      };
      const startTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (Math.abs(lastPos) >= 100) {
            delta += lastPos >= 0 ? p.timerStep : -p.timerStep;
            clampDelta(); show(); startTimer();
          }
        }, p.interval);
      };
      const onDown = (e) => {
        dragging = true; this._dragging = true; delta = 0; lastPos = 0;
        startX = e.clientX; half = (slider.getBoundingClientRect().width / 2) || 1;
        slider.classList.add("is-dragging");
        try { handle.setPointerCapture(e.pointerId); } catch (err) {}
        e.preventDefault();
      };
      const onMove = (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const clamped = Math.max(-half, Math.min(half, dx));
        handle.style.setProperty("--drag", Math.round(clamped) + "px");
        const pos = (dx / half) * 100; lastPos = pos;
        delta = thr(pos); clampDelta(); show();
        if (Math.abs(pos) >= 100) startTimer(); else clearTimeout(timer);
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false; clearTimeout(timer);
        slider.classList.remove("is-dragging");
        handle.style.setProperty("--drag", "0px");
        const finalVal = Math.max(cfg.min, Math.min(cfg.max, p.round(cfg.base + delta)));
        const changed = Math.abs(finalVal - cfg.base) > 1e-6;
        delta = 0; this._dragging = false;
        if (changed) this._commitKnob(cfg.kind, finalVal);
        else this._render();
      };
      handle.addEventListener("pointerdown", onDown);
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    }
  }

  async _commitKnob(kind, value) {
    const device = this._selected;
    const entities = (device && device.entities) || {};
    if (kind === "temp" && entities.thermostat) {
      await this._callService("climate", "set_temperature", { entity_id: entities.thermostat, temperature: value });
    } else if (kind === "eff" && entities.filter_efficiency) {
      await this._callService("number", "set_value", { entity_id: entities.filter_efficiency, value });
    }
  }

  _escape(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
}

if (!customElements.get("aquael-link-panel-v6")) {
  customElements.define("aquael-link-panel-v6", AquaelLinkPanel);
}
