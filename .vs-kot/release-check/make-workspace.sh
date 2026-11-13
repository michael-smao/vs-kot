#!/bin/sh
# vs-kot: makes the throwaway git repository that check.ts works in: one file with an unreviewed change, one
# badly formatted file, a sample for tab completion, and in bar/ files of every kind for the review bar.
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
# For the review bar: its arrows have to be at the same place whatever file is under review. So there is one file of
# each kind that used to move them: with one change, with line numbers of four digits, with twelve changes, deleted
# and new. Together with the others that is more than nine files, so the file counter gets a second digit.
# numbered <name> <lines> <n>: a file of that many lines; every n-th line differs from what "numbered <name> <lines> 0" writes.
numbered() { awk -v name="$1" -v count="$2" -v every="$3" 'BEGIN { for (i = 1; i <= count; i++) print "export const " name "_" i " = " ((every && i % every == 0) ? -i : i) ";" }'; }
mkdir bar
for n in 1 2 3 4 5 6 7 8; do numbered "plain$n" 12 0 > "bar/plain$n.ts"; done
numbered long 1200 0 > bar/long.ts
numbered many 72 0 > bar/many.ts
numbered gone 12 0 > bar/gone.ts
git init -q . && git add . && git -c user.name=test -c user.email=test@example.com commit -qm init
for n in 1 2 3 4 5 6 7 8; do numbered "plain$n" 12 7 > "bar/plain$n.ts"; done
numbered long 1200 500 > bar/long.ts
numbered many 72 6 > bar/many.ts
rm bar/gone.ts
numbered new1 12 0 > bar/new1.ts
numbered new2 12 0 > bar/new2.ts
printf 'export function greet(name: string): string {\n    return `Hello, ${name}!`;\n}\n\nexport function bye(name: string): string {\n    return "Bye " + name;\n}\n' > src/review.ts
git status --short
