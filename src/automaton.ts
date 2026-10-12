export class Automaton {
  readonly edges = new Map<number, number>();
  readonly fail: number[] = [0];
  readonly depth: number[] = [0];
  readonly children: number[] = [0];
  readonly out: number[][] = [[]];
  readonly dict: number[] = [-1];
  readonly lengths: number[] = [];

  add(bytes: Uint8Array): number {
    let node = 0;
    for (const byte of bytes) {
      const key = node * 256 + byte;
      let next = this.edges.get(key);
      if (next === undefined) {
        next = this.depth.length;
        this.edges.set(key, next);
        this.fail.push(0);
        this.depth.push(this.depth[node] + 1);
        this.children.push(0);
        this.children[node] += 1;
        this.out.push([]);
        this.dict.push(-1);
      }
      node = next;
    }
    const id = this.lengths.length;
    this.lengths.push(bytes.length);
    this.out[node].push(id);
    return id;
  }

  build(): void {
    const queue: number[] = [];
    const byNode = new Map<number, [number, number][]>();
    for (const [key, child] of this.edges) {
      const parent = Math.floor(key / 256);
      const list = byNode.get(parent) ?? [];
      list.push([key % 256, child]);
      byNode.set(parent, list);
    }
    for (const [, child] of byNode.get(0) ?? []) queue.push(child);
    for (let head = 0; head < queue.length; head++) {
      const node = queue[head];
      const fallback = this.fail[node];
      this.dict[node] = this.out[fallback].length > 0 ? fallback : this.dict[fallback];
      for (const [byte, child] of byNode.get(node) ?? []) {
        let state = fallback;
        let target = this.edges.get(state * 256 + byte);
        while (target === undefined && state > 0) {
          state = this.fail[state];
          target = this.edges.get(state * 256 + byte);
        }
        this.fail[child] = target ?? 0;
        queue.push(child);
      }
    }
  }

  step(state: number, byte: number): number {
    let current = state;
    for (;;) {
      const next = this.edges.get(current * 256 + byte);
      if (next !== undefined) return next;
      if (current === 0) return 0;
      current = this.fail[current];
    }
  }

  matches(state: number, visit: (id: number) => void): void {
    for (let node = state; node > 0; node = this.dict[node]) {
      for (const id of this.out[node]) visit(id);
    }
  }

  partials(state: number, length: number, visit: (start: number) => void): void {
    for (let node = state; node > 0; node = this.fail[node]) {
      if (this.children[node] > 0) visit(length - this.depth[node]);
    }
  }
}
