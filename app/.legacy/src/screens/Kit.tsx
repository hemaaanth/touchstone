import type { ReactNode } from "react"
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group"
import {
  Accordion,
  AlertDialog,
  Autocomplete,
  Avatar,
  Button,
  Checkbox,
  CheckboxGroup,
  Collapsible,
  ComboboxField,
  ContextMenu,
  Dialog,
  Drawer,
  Field,
  Fieldset,
  Form,
  Input,
  InputLabel,
  Menu,
  Menubar,
  Meter,
  NavigationMenu,
  NumberField,
  OTPField,
  Popover,
  PreviewCard,
  Progress,
  Radio,
  RadioGroup,
  ScrollArea,
  Select,
  SelectField,
  Separator,
  Slider,
  Switch,
  Tabs,
  ThemedIcon,
  Toast,
  Toggle,
  ToggleGroup,
  Toolbar,
  Tooltip,
} from "@graphical"
import { Page } from "@/components/app/blocks"
import { ASSET_NAMES, FINDINGS, MODELS, PROJECT } from "@/data/fixtures"
import { href } from "@/lib/route"

/*
 * Every Graphical component, composed the way its spec describes, with
 * product content. Screens copy from here, so the mockups and the app
 * share one source.
 */

function Specimen({ name, children }: { name: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-(--space-s)">
      <h2 className="type-xs text-(--cte-text-muted)">{name}</h2>
      <div className="flex min-h-[64px] flex-col items-start gap-(--space-m)">{children}</div>
    </section>
  )
}

const SEVERITIES = [
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
]

const TAGS = ["reentrancy", "access control", "oracle", "session", "CORS", "SRI", "DNS", "supply chain"]

export function Kit() {
  const toasts = Toast.useToastManager()

  return (
    <Page crumbs={[{ label: PROJECT.name, to: "home" }, { label: "Kit" }]} title="Component kit">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-x-(--space-xxl) gap-y-(--space-xxl)">
        <Specimen name="Button">
          <div className="flex flex-wrap items-center gap-(--space-s)">
            <Button>Start run</Button>
            <Button variant="secondary">Re-run</Button>
            <Button variant="outline">Export</Button>
            <Button variant="ghost">Cancel</Button>
            <Button variant="danger">Stop all</Button>
            <Button disabled>Start run</Button>
          </div>
        </Specimen>

        <Specimen name="Text field">
          <div className="flex w-full max-w-[320px] flex-col gap-(--space-xs)">
            <InputLabel htmlFor="kit-input">Target URL</InputLabel>
            <Input id="kit-input" placeholder="https://app.acme.xyz" />
          </div>
        </Specimen>

        <Specimen name="Field">
          <Field.Root className="w-full max-w-[320px]">
            <Field.Label>Contract address</Field.Label>
            <Field.Control required defaultValue="0x5c1e…a94f" />
            <Field.Description>Read from the deploy manifest.</Field.Description>
            <Field.Error match="valueMissing">Enter an address.</Field.Error>
          </Field.Root>
        </Specimen>

        <Specimen name="Fieldset">
          <Fieldset.Root className="w-full max-w-[320px]">
            <Fieldset.Legend>Fork</Fieldset.Legend>
            <Field.Root>
              <Field.Label>Chain</Field.Label>
              <Field.Control defaultValue="Ethereum mainnet" />
            </Field.Root>
            <Field.Root>
              <Field.Label>Block</Field.Label>
              <Field.Control defaultValue="23,456,802" />
            </Field.Root>
          </Fieldset.Root>
        </Specimen>

        <Specimen name="Form">
          <Form
            className="w-full max-w-[320px]"
            onSubmit={(event) => {
              event.preventDefault()
              toasts.add({ title: "Scope saved", description: "2 domains added." })
            }}
          >
            <Field.Root>
              <Field.Label>Domain</Field.Label>
              <Field.Control required placeholder="acme.xyz" />
              <Field.Error match="valueMissing">Enter a domain.</Field.Error>
            </Field.Root>
            <Form.Action type="submit">Add to scope</Form.Action>
          </Form>
        </Specimen>

        <Specimen name="Number field">
          <NumberField.Root id="kit-cap" defaultValue={10} min={1} max={50}>
            <NumberField.Label htmlFor="kit-cap">Daily spend cap ($)</NumberField.Label>
            <NumberField.Group>
              <NumberField.Decrement aria-label="Lower the cap">
                <ThemedIcon name="minus" />
              </NumberField.Decrement>
              <NumberField.Input />
              <NumberField.Increment aria-label="Raise the cap">
                <ThemedIcon name="plus" />
              </NumberField.Increment>
            </NumberField.Group>
          </NumberField.Root>
        </Specimen>

        <Specimen name="OTP field">
          <div className="flex flex-col gap-(--space-xs)">
            <OTPField.Label htmlFor="kit-otp">Sign-in code from the test inbox</OTPField.Label>
            <OTPField.Root id="kit-otp" length={6}>
              <OTPField.Input />
              <OTPField.Input />
              <OTPField.Input />
              <OTPField.Separator />
              <OTPField.Input />
              <OTPField.Input />
              <OTPField.Input />
            </OTPField.Root>
          </div>
        </Specimen>

        <Specimen name="Select">
          <Select.Root items={SEVERITIES} defaultValue="medium">
            <Select.Label>Minimum severity</Select.Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Icon />
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup>
                  <Select.List>
                    {SEVERITIES.map((item) => (
                      <Select.Item key={item.value} value={item.value}>
                        <Select.ItemText>{item.label}</Select.ItemText>
                        <Select.ItemIndicator />
                      </Select.Item>
                    ))}
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
          <SelectField
            label="Refuter model"
            defaultValue={MODELS[2].model}
            options={[...new Set(MODELS.map((m) => m.model))].map((model) => ({ value: model, label: model }))}
          />
        </Specimen>

        <Specimen name="Combobox">
          <ComboboxField label="Asset" placeholder={`Search ${ASSET_NAMES.length} assets`} items={ASSET_NAMES} />
        </Specimen>

        <Specimen name="Autocomplete">
          <Autocomplete.Root items={TAGS}>
            <div className="flex w-full max-w-[320px] flex-col gap-(--space-xs)">
              <Autocomplete.Label htmlFor="kit-tag">Tag</Autocomplete.Label>
              <Autocomplete.Input id="kit-tag" placeholder="reentrancy" />
            </div>
            <Autocomplete.Portal>
              <Autocomplete.Positioner>
                <Autocomplete.Popup>
                  <Autocomplete.Empty>No matching tag.</Autocomplete.Empty>
                  <Autocomplete.List>
                    {(tag: string) => (
                      <Autocomplete.Item key={tag} value={tag}>
                        {tag}
                      </Autocomplete.Item>
                    )}
                  </Autocomplete.List>
                </Autocomplete.Popup>
              </Autocomplete.Positioner>
            </Autocomplete.Portal>
          </Autocomplete.Root>
        </Specimen>

        <Specimen name="Checkbox">
          <Checkbox.Row>
            <Checkbox.Root defaultChecked />
            <Checkbox.Label>Ask a person before any write</Checkbox.Label>
          </Checkbox.Row>
        </Specimen>

        <Specimen name="Checkbox group">
          <CheckboxGroup defaultValue={["contracts", "web"]} aria-label="Modules in this run">
            <CheckboxGroup.Row>
              <Checkbox.Root value="contracts" />
              <CheckboxGroup.Label>Contracts</CheckboxGroup.Label>
            </CheckboxGroup.Row>
            <CheckboxGroup.Row>
              <Checkbox.Root value="web" />
              <CheckboxGroup.Label>Web and sign-in</CheckboxGroup.Label>
            </CheckboxGroup.Row>
            <CheckboxGroup.Row>
              <Checkbox.Root value="domains" />
              <CheckboxGroup.Label>Domains and front end</CheckboxGroup.Label>
            </CheckboxGroup.Row>
          </CheckboxGroup>
        </Specimen>

        <Specimen name="Radio">
          <BaseRadioGroup defaultValue="fork" aria-label="Where to prove">
            <Radio.Row>
              <Radio.Root value="fork">
                <Radio.Indicator />
              </Radio.Root>
              <Radio.Label>Local fork</Radio.Label>
            </Radio.Row>
          </BaseRadioGroup>
        </Specimen>

        <Specimen name="Radio group">
          <RadioGroup defaultValue="fork" aria-label="Where to prove">
            <RadioGroup.Row>
              <Radio.Root value="fork">
                <Radio.Indicator />
              </Radio.Root>
              <RadioGroup.Label>Local fork</RadioGroup.Label>
            </RadioGroup.Row>
            <RadioGroup.Row>
              <Radio.Root value="testnet">
                <Radio.Indicator />
              </Radio.Root>
              <RadioGroup.Label>Public testnet</RadioGroup.Label>
            </RadioGroup.Row>
            <RadioGroup.Row>
              <Radio.Root value="read" disabled>
                <Radio.Indicator />
              </Radio.Root>
              <RadioGroup.Label>Read only</RadioGroup.Label>
            </RadioGroup.Row>
          </RadioGroup>
        </Specimen>

        <Specimen name="Switch">
          <Switch.Row>
            <Switch.Root defaultChecked />
            <Switch.Label>Run on every deploy</Switch.Label>
          </Switch.Row>
        </Specimen>

        <Specimen name="Slider">
          <Slider.Root defaultValue={3} min={1} max={8} className="w-full max-w-[320px]">
            <Slider.Heading>
              <Slider.Label>Parallel runs</Slider.Label>
              <Slider.Value />
            </Slider.Heading>
            <Slider.Control>
              <Slider.Track>
                <Slider.Indicator />
                <Slider.Thumb aria-label="Parallel runs" />
              </Slider.Track>
            </Slider.Control>
          </Slider.Root>
        </Specimen>

        <Specimen name="Meter">
          <Meter.Root
            value={3.2}
            max={10}
            format={{ style: "currency", currency: "USD" }}
            className="w-full max-w-[320px]"
          >
            <Meter.Heading>
              <Meter.Label>Spend today</Meter.Label>
              <Meter.Value />
            </Meter.Heading>
            <Meter.Track>
              <Meter.Indicator />
            </Meter.Track>
          </Meter.Root>
        </Specimen>

        <Specimen name="Progress">
          <Progress.Root value={62} className="w-full max-w-[320px]">
            <Progress.Heading>
              <Progress.Label>Run 131, step 5 of 8</Progress.Label>
              <Progress.Value />
            </Progress.Heading>
            <Progress.Track>
              <Progress.Indicator />
            </Progress.Track>
          </Progress.Root>
        </Specimen>

        <Specimen name="Toggle">
          <Toggle defaultPressed>
            <ThemedIcon name="bell" />
            <Toggle.Label>Notify me</Toggle.Label>
          </Toggle>
        </Specimen>

        <Specimen name="Toggle group">
          <ToggleGroup defaultValue={["7d"]} aria-label="Time range">
            <Toggle value="24h">
              <ToggleGroup.Label>24 h</ToggleGroup.Label>
            </Toggle>
            <Toggle value="7d">
              <ToggleGroup.Label>7 days</ToggleGroup.Label>
            </Toggle>
            <Toggle value="30d">
              <ToggleGroup.Label>30 days</ToggleGroup.Label>
            </Toggle>
          </ToggleGroup>
        </Specimen>

        <Specimen name="Toolbar">
          <Toolbar.Root aria-label="Proof">
            <Toolbar.Group aria-label="Copy">
              <Toolbar.Button aria-label="Copy command">
                <ThemedIcon name="copy" />
              </Toolbar.Button>
              <Toolbar.Button aria-label="Download evidence">
                <ThemedIcon name="download" />
              </Toolbar.Button>
            </Toolbar.Group>
            <Toolbar.Separator />
            <Toolbar.Link href={href("kit", "finding/F-0042")}>Open finding</Toolbar.Link>
          </Toolbar.Root>
        </Specimen>

        <Specimen name="Tabs">
          <Tabs.Root defaultValue="proof" className="w-full">
            <Tabs.List>
              <Tabs.Tab value="proof">Proof</Tabs.Tab>
              <Tabs.Tab value="trace">Trace</Tabs.Tab>
              <Tabs.Tab value="fix">Fix</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="proof">
              <Tabs.Content>The vault lost 412.7 ETH on the fork.</Tabs.Content>
            </Tabs.Panel>
            <Tabs.Panel value="trace">
              <Tabs.Content>Trace hash 0x7c1e…a94f.</Tabs.Content>
            </Tabs.Panel>
            <Tabs.Panel value="fix">
              <Tabs.Content>Move the balance update above the call.</Tabs.Content>
            </Tabs.Panel>
          </Tabs.Root>
        </Specimen>

        <Specimen name="Accordion">
          <Accordion.Root className="w-full max-w-[320px]">
            <Accordion.Item value="why">
              <Accordion.Header>
                <Accordion.Trigger>
                  Why it is High
                  <Accordion.Indicator>
                    <ThemedIcon name="chevronRight" />
                  </Accordion.Indicator>
                </Accordion.Trigger>
              </Accordion.Header>
              <Accordion.Panel>
                <Accordion.Content>Anyone can drain the vault in one transaction.</Accordion.Content>
              </Accordion.Panel>
            </Accordion.Item>
            <Accordion.Item value="refuter">
              <Accordion.Header>
                <Accordion.Trigger>
                  What the refuter tried
                  <Accordion.Indicator>
                    <ThemedIcon name="chevronRight" />
                  </Accordion.Indicator>
                </Accordion.Trigger>
              </Accordion.Header>
              <Accordion.Panel>
                <Accordion.Content>It re-ran the test with the guard on. The drain stopped.</Accordion.Content>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion.Root>
        </Specimen>

        <Specimen name="Collapsible">
          <Collapsible.Root className="w-full max-w-[320px]">
            <Collapsible.Trigger>
              Show the command
              <Collapsible.Indicator>
                <ThemedIcon name="chevronRight" />
              </Collapsible.Indicator>
            </Collapsible.Trigger>
            <Collapsible.Panel>
              <Collapsible.Content>forge test --match-test testWithdrawReentrancy</Collapsible.Content>
            </Collapsible.Panel>
          </Collapsible.Root>
        </Specimen>

        <Specimen name="Separator">
          <div className="flex w-full flex-col gap-(--space-s) type-s">
            <span>Machine verdict: Proven</span>
            <Separator />
            <span>Human verdict: waiting</span>
          </div>
        </Specimen>

        <Specimen name="Scroll area">
          <ScrollArea.Root className="h-[120px] w-full max-w-[320px]">
            <ScrollArea.Viewport className="h-full">
              <ScrollArea.Content>
                <ol className="flex flex-col gap-(--space-xxs) font-data type-xs">
                  {FINDINGS.concat(FINDINGS).map((finding, index) => (
                    <li key={index}>
                      {finding.id} {finding.title}
                    </li>
                  ))}
                </ol>
              </ScrollArea.Content>
            </ScrollArea.Viewport>
            <ScrollArea.Scrollbar orientation="vertical">
              <ScrollArea.Thumb />
            </ScrollArea.Scrollbar>
          </ScrollArea.Root>
        </Specimen>

        <Specimen name="Avatar">
          <div className="flex items-center gap-(--space-s) type-s">
            <Avatar.Root>
              <Avatar.Fallback>HM</Avatar.Fallback>
            </Avatar.Root>
            <span>You</span>
          </div>
        </Specimen>

        <Specimen name="Menu">
          <Menu.Root>
            <Menu.Trigger>
              Actions
              <ThemedIcon name="chevronDown" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner sideOffset={4} align="start">
                <Menu.Popup>
                  <Menu.Item>
                    <Menu.ItemContent icon={<ThemedIcon name="play" />} shortcut="R">
                      Re-run proof
                    </Menu.ItemContent>
                  </Menu.Item>
                  <Menu.Item>
                    <Menu.ItemContent icon={<ThemedIcon name="copy" />}>Copy command</Menu.ItemContent>
                  </Menu.Item>
                  <Menu.CheckboxItem defaultChecked>
                    <Menu.CheckboxItemIndicator>
                      <ThemedIcon name="check" />
                    </Menu.CheckboxItemIndicator>
                    Watch this finding
                  </Menu.CheckboxItem>
                  <Menu.Separator />
                  <Menu.SubmenuRoot>
                    <Menu.SubmenuTrigger>
                      <Menu.ItemContent submenu>Mark as</Menu.ItemContent>
                    </Menu.SubmenuTrigger>
                    <Menu.Portal>
                      <Menu.Positioner sideOffset={4}>
                        <Menu.Popup>
                          <Menu.Item>Accepted risk</Menu.Item>
                          <Menu.Item>Duplicate</Menu.Item>
                          <Menu.Item>Not a bug</Menu.Item>
                        </Menu.Popup>
                      </Menu.Positioner>
                    </Menu.Portal>
                  </Menu.SubmenuRoot>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </Specimen>

        <Specimen name="Menubar">
          <Menubar>
            <Menu.Root>
              <Menubar.Trigger>Run</Menubar.Trigger>
              <Menu.Portal>
                <Menu.Positioner sideOffset={4} align="start">
                  <Menu.Popup>
                    <Menu.Item>Start</Menu.Item>
                    <Menu.Item>Pause</Menu.Item>
                    <Menu.Separator />
                    <Menu.Item>Stop</Menu.Item>
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
            <Menu.Root>
              <Menubar.Trigger>Evidence</Menubar.Trigger>
              <Menu.Portal>
                <Menu.Positioner sideOffset={4} align="start">
                  <Menu.Popup>
                    <Menu.GroupLabel>Export as</Menu.GroupLabel>
                    <Menu.Item>Markdown</Menu.Item>
                    <Menu.Item>JSON bundle</Menu.Item>
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
          </Menubar>
        </Specimen>

        <Specimen name="Context menu">
          <ContextMenu.Root>
            <ContextMenu.Trigger className="grid min-h-[96px] w-full max-w-[280px] place-items-center rounded-(--radius-m) bg-(--cte-surface-muted) type-s text-(--cte-text-muted)">
              Right-click F-0042
            </ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Positioner>
                <ContextMenu.Popup>
                  <ContextMenu.Item>Open</ContextMenu.Item>
                  <ContextMenu.Item>Copy ID</ContextMenu.Item>
                  <ContextMenu.Separator />
                  <ContextMenu.Item>Re-run proof</ContextMenu.Item>
                </ContextMenu.Popup>
              </ContextMenu.Positioner>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        </Specimen>

        <Specimen name="Navigation menu">
          <NavigationMenu.Root>
            <NavigationMenu.List>
              <NavigationMenu.Item>
                <NavigationMenu.Trigger>
                  Chain
                  <NavigationMenu.Icon>
                    <ThemedIcon name="chevronDown" />
                  </NavigationMenu.Icon>
                </NavigationMenu.Trigger>
                <NavigationMenu.Content className="flex flex-col">
                  <NavigationMenu.Link href={href("kit", "coverage/keys")}>Keys and signing</NavigationMenu.Link>
                  <NavigationMenu.Link href={href("kit", "coverage/contracts")}>Contracts</NavigationMenu.Link>
                  <NavigationMenu.Link href={href("kit", "coverage/chain-watch")}>Chain watch</NavigationMenu.Link>
                </NavigationMenu.Content>
              </NavigationMenu.Item>
              <NavigationMenu.Item>
                <NavigationMenu.Link href={href("automations")}>Automations</NavigationMenu.Link>
              </NavigationMenu.Item>
            </NavigationMenu.List>
            <NavigationMenu.Portal>
              <NavigationMenu.Positioner sideOffset={4}>
                <NavigationMenu.Popup>
                  <NavigationMenu.Viewport />
                </NavigationMenu.Popup>
              </NavigationMenu.Positioner>
            </NavigationMenu.Portal>
          </NavigationMenu.Root>
        </Specimen>

        <Specimen name="Tooltip">
          <Tooltip.Root>
            <Tooltip.Trigger>Proven</Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Positioner sideOffset={4}>
                <Tooltip.Popup>The exploit ran on a fork and moved funds.</Tooltip.Popup>
              </Tooltip.Positioner>
            </Tooltip.Portal>
          </Tooltip.Root>
        </Specimen>

        <Specimen name="Popover">
          <Popover.Root>
            <Popover.Trigger>Spend</Popover.Trigger>
            <Popover.Portal>
              <Popover.Positioner sideOffset={4} align="start">
                <Popover.Popup>
                  <Popover.Title>$3.20 of $10 today</Popover.Title>
                  <Popover.Description>Runs pause at the cap. Raise it in Settings.</Popover.Description>
                  <Popover.Close>Close</Popover.Close>
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        </Specimen>

        <Specimen name="Preview card">
          <p className="type-s">
            Blocked by{" "}
            <PreviewCard.Root>
              <PreviewCard.Trigger href={href("kit", "finding/F-0042")}>F-0042</PreviewCard.Trigger>
              <PreviewCard.Portal>
                <PreviewCard.Positioner sideOffset={4}>
                  <PreviewCard.Popup>
                    <PreviewCard.Title>Vault.withdraw reentrancy</PreviewCard.Title>
                    <PreviewCard.Description>High · Proven on a fork · 412.7 ETH moved</PreviewCard.Description>
                  </PreviewCard.Popup>
                </PreviewCard.Positioner>
              </PreviewCard.Portal>
            </PreviewCard.Root>
          </p>
        </Specimen>

        <Specimen name="Dialog">
          <Dialog.Root>
            <Dialog.Trigger>Add a domain</Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Backdrop />
              <Dialog.Popup>
                <Dialog.Title>Add a domain to Acme Protocol</Dialog.Title>
                <Dialog.Description>
                  The agent looks at it from outside and proposes a scope change. Nothing is tested until you confirm.
                </Dialog.Description>
                <Field.Root>
                  <Field.Label>Domain</Field.Label>
                  <Field.Control placeholder="app.acme.xyz" />
                </Field.Root>
                <div className="flex justify-end gap-(--space-s)">
                  <Dialog.Close>Cancel</Dialog.Close>
                  <Dialog.Action>Add</Dialog.Action>
                </div>
              </Dialog.Popup>
            </Dialog.Portal>
          </Dialog.Root>
        </Specimen>

        <Specimen name="Alert dialog">
          <AlertDialog.Root>
            <AlertDialog.Trigger>Stop all</AlertDialog.Trigger>
            <AlertDialog.Portal>
              <AlertDialog.Backdrop />
              <AlertDialog.Popup>
                <AlertDialog.Title>Stop 3 runs and 1 watch?</AlertDialog.Title>
                <AlertDialog.Description>
                  Forks shut down. Partial evidence is kept.
                </AlertDialog.Description>
                <div className="flex justify-end gap-(--space-s)">
                  <AlertDialog.Close>Keep running</AlertDialog.Close>
                  <AlertDialog.Action>Stop all</AlertDialog.Action>
                </div>
              </AlertDialog.Popup>
            </AlertDialog.Portal>
          </AlertDialog.Root>
        </Specimen>

        <Specimen name="Drawer">
          <Drawer.Root>
            <Drawer.Trigger>Show evidence</Drawer.Trigger>
            <Drawer.Portal>
              <Drawer.Backdrop />
              <Drawer.Viewport>
                <Drawer.Popup>
                  <Drawer.Content>
                    <span
                      aria-hidden="true"
                      className="mx-auto mb-(--space-xs) block h-(--space-xxs) w-[calc(var(--space-xl)*2)] rounded-(--radius-full) bg-(--neutral-4)"
                    />
                    <Drawer.Title>Evidence for F-0042</Drawer.Title>
                    <Drawer.Description>sha256:9f2b…41ce, stored with the run.</Drawer.Description>
                    <div className="flex justify-end gap-(--space-s)">
                      <Drawer.Close>Close</Drawer.Close>
                      <Drawer.Action>Download</Drawer.Action>
                    </div>
                  </Drawer.Content>
                </Drawer.Popup>
              </Drawer.Viewport>
            </Drawer.Portal>
          </Drawer.Root>
        </Specimen>

        <Specimen name="Toast">
          <Toast.Trigger
            onClick={() =>
              toasts.add({ title: "Proof finished", description: "F-0042 is Proven. 412.7 ETH moved on the fork." })
            }
          >
            Show a toast
          </Toast.Trigger>
        </Specimen>
      </div>
    </Page>
  )
}
