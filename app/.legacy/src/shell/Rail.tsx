import { Menu, Switch, ThemedIcon, type ThemeIconName } from "@graphical"
import { cn } from "cn"
import { Dot, Tag } from "@/components/app/blocks"
import { AUTOMATIONS, PROJECT, PROJECTS, SANDBOX } from "@/data/fixtures"
import { liveRuns, useActions, useFindings } from "@/lib/actions"
import { openFindings } from "@/lib/answer"
import { useColorMode } from "@/lib/color-mode"
import { href, useRoute, type Route } from "@/lib/route"
import { useWords } from "@/lib/words"

/*
 * The left rail. Five places, a project switcher, live runs and the sandbox.
 * The 13 modules are not here: they are a catalog in the Coverage panel.
 */

const ROW =
  "flex w-full min-w-0 items-center gap-(--space-xs) rounded-(--radius-s) px-(--space-s) py-(--space-xxs) type-s text-left focus-ring hover:bg-(--cte-surface-muted)"
const CURRENT =
  "aria-[current=page]:bg-(--navigation-active-background) aria-[current=page]:text-(--navigation-active-foreground) aria-[current=page]:hover:bg-(--navigation-active-background)"
const MARK = "ml-auto shrink-0 pl-(--space-s) font-data tabular-nums type-xs text-(--cte-text-muted)"

type Place = { route: Route; label: string; icon: ThemeIconName; mark?: string }

export function Rail() {
  const route = useRoute()
  // First run is a new project: no findings, automations or runs yet.
  const firstRun = route === "first-run"
  const running = liveRuns(useActions())
  const open = openFindings(useFindings()).length
  const places: Place[] = [
    { route: "home", label: "Home", icon: "home" },
    { route: "findings", label: "Findings", icon: "inboxTray", mark: firstRun ? undefined : String(open) },
    { route: "scope", label: "Scope", icon: "shieldCheck" },
    { route: "automations", label: "Automations", icon: "timer", mark: firstRun ? undefined : String(AUTOMATIONS.length) },
    { route: "settings", label: "Settings", icon: "settings" },
  ]

  return (
    <nav aria-label="Main" className="flex w-[240px] min-h-0 shrink-0 flex-col bg-(--cte-surface) divide-right">
      <div className="px-(--space-s) pt-(--space-s)">
        <ProjectSwitcher />
      </div>

      <ul className="flex flex-col gap-(--space-xxs) px-(--space-s) pt-(--space-m)">
        {places.map((place) => (
          <li key={place.route}>
            <a
              href={href(place.route)}
              aria-current={route === place.route ? "page" : undefined}
              className={cn(ROW, CURRENT)}
            >
              <ThemedIcon name={place.icon} />
              <span className="truncate">{place.label}</span>
              {place.mark ? <span className={MARK}>{place.mark}</span> : null}
            </a>
          </li>
        ))}
      </ul>

      {!firstRun && running.length > 0 ? (
        <>
          <Heading>Running</Heading>
          <ul className="flex flex-col gap-(--space-xxs) px-(--space-s)">
            {running.map((run) => (
              <li key={run.id}>
                <a href={href(route, `run/${run.id}`)} className={ROW}>
                  <Dot tone="accent" />
                  <span className="truncate">
                    #{run.id} {run.label}
                  </span>
                  <span className={MARK}>{run.step}</span>
                </a>
                <p className="px-(--space-s) pl-[calc(var(--space-s)+var(--space-xs)+var(--space-xs))] type-xs text-(--cte-text-muted)">
                  {run.state}
                </p>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <div className="mt-auto flex shrink-0 flex-col gap-(--space-xs) px-(--space-s) py-(--space-s) divide-top">
        <SandboxLine />
        <WordsSwitch />
        <DarkSwitch />
        <a
          href={href("kit")}
          aria-current={route === "kit" ? "page" : undefined}
          className="self-start rounded-(--radius-xs) px-(--space-s) type-xs text-(--cte-text-muted) hover:text-(--cte-text) focus-ring"
        >
          Kit
        </a>
      </div>
    </nav>
  )
}

function Heading({ children }: { children: string }) {
  return (
    <div className="flex items-center px-(--space-m) pt-(--space-l) pb-(--space-xxs)">
      <span className="type-xs text-(--cte-text-muted)">{children}</span>
    </div>
  )
}

function ProjectSwitcher() {
  return (
    <Menu.Root>
      <Menu.Trigger className={cn(ROW, "weight-medium")}>
        <span className="truncate">{PROJECT.name}</span>
        <ThemedIcon name="chevronDown" className="ml-auto shrink-0" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} align="start">
          <Menu.Popup>
            <Menu.GroupLabel>Projects</Menu.GroupLabel>
            <Menu.RadioGroup value={PROJECTS.find((project) => project.current)?.name}>
              {PROJECTS.map((project) => (
                <Menu.RadioItem key={project.name} value={project.name}>
                  <Menu.RadioItemIndicator>
                    <ThemedIcon name="check" />
                  </Menu.RadioItemIndicator>
                  <span className="flex min-w-0 flex-1 items-center gap-(--space-xs)">
                    <span className="truncate">{project.name}</span>
                    {project.limited ? <Tag>Limited</Tag> : null}
                    <span className="ml-auto type-xs text-(--cte-text-muted)">{project.access}</span>
                  </span>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
            <Menu.Separator />
            <Menu.Item render={<a href={href("first-run")} />}>Add a project</Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

function SandboxLine() {
  const ok = SANDBOX.selfTest.result === "passed"
  return (
    <a href={href("settings")} className={cn(ROW, "flex-wrap")}>
      <Dot tone={ok ? "success" : "error"} />
      <span>{ok ? "Sandbox ok" : "Sandbox down"}</span>
      <span className={MARK}>{SANDBOX.inUseLabel}</span>
      <span className="w-full pl-[calc(var(--space-xs)+var(--space-xs))] type-xs text-(--cte-text-muted)">
        {SANDBOX.isolationLabel}
      </span>
    </a>
  )
}

function WordsSwitch() {
  const { technical, setWords } = useWords()
  return (
    <Switch.Row className="px-(--space-s)">
      <Switch.Root checked={technical} onCheckedChange={(checked) => setWords(checked ? "technical" : "plain")}>
        <Switch.Thumb />
      </Switch.Root>
      <Switch.Label>Technical words</Switch.Label>
    </Switch.Row>
  )
}

function DarkSwitch() {
  const { colorMode, setColorMode } = useColorMode()
  return (
    <Switch.Row className="px-(--space-s)">
      <Switch.Root checked={colorMode === "dark"} onCheckedChange={(checked) => setColorMode(checked ? "dark" : "light")}>
        <Switch.Thumb />
      </Switch.Root>
      <Switch.Label>Dark</Switch.Label>
    </Switch.Row>
  )
}
