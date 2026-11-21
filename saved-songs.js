// SavedSongs: songs saved in this browser (localStorage), newest first: [{ id, saved (ms), data }] where data is
// Song.toJSON(). Songs are compared as JSON text. Loading or deleting takes a second tap within 3 s (confirm() isn't
// reliable in the iPad plugin's web view): arm() / isArmed() / disarm(), with onArmChange called when that changes.
// Loaded as a classic script (window.GoKeys.SavedSongs) or with require() in Node (tests; pass a storage object).
(function () {
  'use strict';

  class SavedSongs {
    constructor(storage, key) {
      this.storage = storage; this.key = key || 'gokeys-songs';
      this.items = null;
      this.armed = null; this.armTimer = 0; this.onArmChange = null;
    }
    list() {
      if (!this.items) {
        try { this.items = JSON.parse(this.storage.getItem(this.key) || '[]') || []; } catch (e) { this.items = []; }
        if (!Array.isArray(this.items)) this.items = [];
      }
      return this.items;
    }
    // false: storage is full or blocked.
    store() {
      try { this.storage.setItem(this.key, JSON.stringify(this.list())); return true; } catch (e) { return false; }
    }
    get(id) { return this.list().find((e) => e.id === id) || null; }
    // Overwrite entry id, or add a new one (id null). Returns { entry, ok }.
    save(data, id) {
      let e = id ? this.get(id) : null;
      if (!e) { e = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6) }; this.list().unshift(e); }
      e.saved = Date.now(); e.data = JSON.parse(JSON.stringify(data));
      this.items.sort((a, b) => b.saved - a.saved);
      return { entry: e, ok: this.store() };
    }
    remove(id) { this.items = this.list().filter((e) => e.id !== id); return this.store(); }
    same(id, data) { const e = this.get(id); return !!e && JSON.stringify(e.data) === JSON.stringify(data); }
    matching(data) { const s = JSON.stringify(data), e = this.list().find((x) => JSON.stringify(x.data) === s); return e ? e.id : null; }

    arm(kind, id) {
      this.armed = { kind, id };
      clearTimeout(this.armTimer); this.armTimer = setTimeout(() => this.disarm(), 3000);
      if (this.onArmChange) this.onArmChange();
    }
    disarm() {
      this.armed = null; clearTimeout(this.armTimer); this.armTimer = 0;
      if (this.onArmChange) this.onArmChange();
    }
    isArmed(kind, id) { return !!this.armed && this.armed.kind === kind && this.armed.id === id; }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = SavedSongs;
  else (window.GoKeys = window.GoKeys || {}).SavedSongs = SavedSongs;
}());
