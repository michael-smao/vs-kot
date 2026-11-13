#!/bin/sh
# vs-kot: makes the throwaway git repository that check.cjs works in: one file with an unreviewed change, one
# badly formatted file, and a sample for tab completion.
# Usage: .vs-kot/release-check/make-workspace.sh <folder to create>
set -e
WS="$1"; rm -rf "$WS"; mkdir -p "$WS/src"; cd "$WS"
cat > src/types.ts <<'T'
export interface Item { name: string; price: number; qty: number; }
export interface Order { id: string; items: Item[]; paidAt: Date | null; }
export function applyTax(amount: number): number { return amount * 1.19; }
T
cat > src/OrderService.ts <<'T'
import { Item, Order, applyTax } from './types';

export class OrderService {
    total(order: Order): number {
        const sum = order.items.reduce((acc, item) => acc + item.price * item.qty, 0);
        return applyTax(sum);
    }

    isPaid(order: Order): boolean {
        return order.paidAt !== null;
    }

    // Returns the items that cost more than the given amount.
    expensiveItems(order: Order, amount: number): Item[] {
        
    }

    // Returns how many items the order has, counting quantities.

    describe(order: Order): string {
        
    }
}
T
printf 'export function add(a:number,b:number){\n  return a+b\n}\nexport const names=[%sa%s,%sb%s]\n' "'" "'" "'" "'" > src/messy.ts
printf 'export function greet(name: string): string {\n    return "Hello " + name;\n}\n\nexport function bye(name: string): string {\n    return "Bye " + name;\n}\n' > src/review.ts
git init -q . && git add . && git -c user.name=test -c user.email=test@example.com commit -qm init
printf 'export function greet(name: string): string {\n    return `Hello, ${name}!`;\n}\n\nexport function bye(name: string): string {\n    return "Bye " + name;\n}\n' > src/review.ts
git status --short
