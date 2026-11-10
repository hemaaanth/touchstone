// shadcn's components.json aliases `utils` → `@/lib/utils`, so Elements pulled
// from the registry import `cn` from here. Our hand-written ui/* import the `cn`
// npm package directly; this shim keeps both paths pointing at one implementation.
export { cn } from "cn"
