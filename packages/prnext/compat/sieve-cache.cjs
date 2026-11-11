'use strict';

// Bounded FIFO admission with a second chance for entries observed by get().
// Hits never unlink/reinsert Map entries. Only eviction advances the hand.
class SieveCache {
  constructor({ maxEntries = 32, maxBytes = Infinity, onEvict } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || !(maxBytes >= 0) || (maxBytes !== Infinity && !Number.isSafeInteger(maxBytes))) throw new TypeError('Invalid cache budget');
    this.limit = maxEntries; this.maxBytes = maxBytes; this.onEvict = onEvict;
    this.nodes = new Map(); this.bytes = 0;
    this.head = this.tail = this.hand = undefined;
  }
  get size() { return this.nodes.size; }
  has(key) { return this.nodes.has(key); }
  get(key) {
    const node = this.nodes.get(key);
    if (!node) return undefined;
    node.visited = true;
    return node.value;
  }
  delete(key) {
    const node = this.nodes.get(key);
    if (!node) return false;
    this.nodes.delete(key); this.bytes -= node.weight;
    if (node.previous) node.previous.next = node.next; else this.head = node.next;
    if (node.next) node.next.previous = node.previous; else this.tail = node.previous;
    if (this.hand === node) this.hand = node.next;
    node.next = node.previous = undefined;
    this.onEvict?.(key, node.value);
    return true;
  }
  evict() {
    let node = this.hand || this.head;
    if (!node) return;
    while (node.visited) { node.visited = false; node = node.next || this.head; }
    this.hand = node.next;
    this.delete(node.key);
  }
  set(key, value, weight = 0) {
    if (!Number.isSafeInteger(weight) || weight < 0) throw new TypeError('Invalid cache entry weight');
    let node = this.nodes.get(key);
    if (!this.limit || weight > this.maxBytes) { this.delete(key); return false; }
    if (node) {
      this.bytes += weight - node.weight; node.value = value; node.weight = weight;
      while (this.bytes > this.maxBytes) this.evict();
      return this.nodes.has(key);
    }
    while (this.size >= this.limit || this.bytes + weight > this.maxBytes) this.evict();
    node = { key, value, weight, visited: false, previous: this.tail, next: undefined };
    if (this.tail) this.tail.next = node; else this.head = node;
    this.tail = node; this.nodes.set(key, node); this.bytes += weight;
    return true;
  }
  clear() { for (const key of this.nodes.keys()) this.delete(key); }
}
module.exports = { SieveCache };
