import { useState } from "react"
import { Button, Toast } from "@graphical"
import { Banner, Dot, KeyValues, Muted, Page, Section, Table, Tag } from "@/components/app/blocks"
import { ScopeChanges } from "@/components/app/cards"
import { BEFORE_PROOF, GRANT, IN_SCOPE, NEAR_LIMITED, PROJECT, type Asset, type OutsideScope } from "@/data/fixtures"
import { accessMix, countByAccess } from "@/lib/answer"
import { useWords } from "@/lib/words"

/*
 * Scope.
 *   The active version and its scope hash.
 *   Assets: tier, access, access because, proof, Limited.
 *   Never touch.
 *   Found outside scope (B9). "Add to scope" starts a scope change (a v4 draft).
 *   The current version and the diff against the previous one.
 * No simulator. No version history beyond the previous version.
 * You confirm a version by typing the project name. No wallet. No signing.
 */

const BEFORE_PROOF_TECHNICAL = "P and F steps can run before proof. S and I steps wait for proof."

export function Scope() {
  const { pick } = useWords()
  const toasts = Toast.useToastManager()
  const [draft, setDraft] = useState<OutsideScope[]>([])
  const [current, previous] = PROJECT.versions
  const next = `v${Number(GRANT.version.slice(1)) + 1}`
  const access = countByAccess()
  const limited = IN_SCOPE.some((asset) => asset.limited)

  function addToScope(item: OutsideScope) {
    setDraft((list) => (list.includes(item) ? list : [...list, item]))
    toasts.add({
      title: `Scope change started: ${next} draft`,
      description: `${item.label} is in the draft. ${GRANT.version} stays active until you confirm ${next}.`,
    })
  }

  function changeScope() {
    toasts.add({
      title: "Tell the agent what to change",
      description: `Ask in the chat. The agent posts a ${next} proposal. ${GRANT.version} stays active until you confirm it.`,
    })
  }

  return (
    <Page
      crumbs={[{ label: PROJECT.name, to: "home" }, { label: "Scope" }]}
      title="Scope"
      meta={
        <>
          <span>
            {GRANT.version} active · Confirmed {GRANT.confirmed}. {GRANT.confirmedHow}.
          </span>
          <span>
            Scope hash <span className="font-data">{GRANT.scopeHash}</span>
          </span>
          <span>Ceiling: {GRANT.ceiling}</span>
          <span>Ends {GRANT.ends}</span>
        </>
      }
      actions={
        <Button variant="secondary" onClick={changeScope}>
          Change scope
        </Button>
      }
      banner={
        draft.length ? (
          <Banner>
            <Dot tone="accent" />
            <span className="min-w-0 flex-1">
              Scope change started. Draft {next} adds {draft.map((item) => item.label).join(", ")}. {GRANT.version}{" "}
              stays active until you confirm {next} by typing the project name.
            </span>
            <Button variant="ghost" onClick={() => setDraft([])}>
              Discard draft
            </Button>
          </Banner>
        ) : undefined
      }
    >
      <Section title="Assets" count={IN_SCOPE.length} action={<Muted className="type-xs">{accessMix()}</Muted>}>
        <div className="overflow-x-auto">
          <Table
            head={["Asset", "Tier", "Access", "Access because", "Proof"]}
            rows={IN_SCOPE.map((asset) => ({ key: asset.id, cells: assetCells(asset, pick) }))}
          />
        </div>
        <Muted className="type-xs">
          {access.Source} with Source access, {access.Public} with Public access. Public access cannot prove ownership,
          so those assets stay Look only.
        </Muted>
        {limited ? (
          <p className="flex items-center gap-(--space-s) type-xs">
            <Tag>Limited</Tag>
            <span>{NEAR_LIMITED}</span>
          </p>
        ) : null}
      </Section>

      <Section title="Never touch" count={PROJECT.neverTouch.length}>
        <ul className="flex flex-col">
          {PROJECT.neverTouch.map((rule) => (
            <li key={rule.item} className="flex items-center gap-(--space-s) py-(--space-s) type-s divide-bottom">
              <Dot tone="error" />
              <span className="weight-medium">{rule.item}</span>
              <Muted>{rule.why}</Muted>
            </li>
          ))}
        </ul>
        <Muted className="type-xs">Code blocks these for every run. A model cannot change this list.</Muted>
      </Section>

      <Section title="Found outside scope" count={PROJECT.foundOutsideScope.length}>
        <ul className="flex flex-col">
          {PROJECT.foundOutsideScope.map((item) => {
            const added = draft.includes(item)
            return (
              <li key={item.item} className="flex items-center gap-(--space-m) py-(--space-s) type-s divide-bottom">
                <div className="flex min-w-0 flex-1 flex-col gap-(--space-xxs)">
                  <span>
                    <span className="weight-medium">{item.label}</span>{" "}
                    <Muted className="font-data type-xs">{item.item}</Muted>
                  </span>
                  <Muted className="type-xs">
                    {item.how} · {item.when}
                  </Muted>
                </div>
                <Tag>{added ? `In ${next} draft` : item.state}</Tag>
                <Button variant="secondary" disabled={added} onClick={() => addToScope(item)}>
                  Add to scope
                </Button>
              </li>
            )
          })}
        </ul>
        <Muted className="type-xs">
          Seen while tracing. Never tested. Adding one starts a scope change that you confirm.
        </Muted>
      </Section>

      <Section title="Version">
        <KeyValues
          rows={[
            [
              "Current",
              <span key="current">
                {current.version} · Confirmed {current.confirmed} · {current.inScope} in scope, {current.neverTouch}{" "}
                never touch ·{" "}
                <span className="font-data">{current.scopeHash}</span>
              </span>,
            ],
            [
              "Previous",
              <span key="previous">
                {previous.version} · Confirmed {previous.confirmed} · {previous.inScope} in scope, {previous.neverTouch} never
                touch ·{" "}
                <span className="font-data">{previous.scopeHash}</span>
              </span>,
            ],
          ]}
        />
        <div className="flex flex-col gap-(--space-xs)">
          <h3 className="type-xs weight-medium text-(--cte-text-muted)">
            Changes from {previous.version} to {current.version}
          </h3>
          <ScopeChanges changes={PROJECT.diff} />
        </div>
        {draft.length ? (
          <div className="flex flex-col gap-(--space-xs)">
            <h3 className="type-xs weight-medium text-(--cte-text-muted)">Draft {next}. Not confirmed.</h3>
            <ScopeChanges
              changes={draft.map((item) => ({
                mark: "+",
                item: `${item.label} (${item.item})`,
                detail: "Added from Found outside scope. Public access, look only until proof.",
              }))}
            />
          </div>
        ) : null}
      </Section>
    </Page>
  )
}

type Pick = <T>(plain: T, technical: T) => T

function assetCells(asset: Asset, pick: Pick) {
  return [
    <div key="asset" className="flex min-w-[180px] flex-col gap-(--space-xxs)">
      <span className="flex items-center gap-(--space-xs)">
        <span className="weight-medium">{asset.name}</span>
        {asset.limited ? <Tag>Limited</Tag> : null}
      </span>
      <Muted className="type-xs">
        {asset.kind}
        {asset.address && asset.address !== asset.name ? (
          <>
            {" · "}
            <span className="font-data">{asset.address}</span>
          </>
        ) : null}
        {asset.threshold ? ` · ${asset.threshold}` : null}
      </Muted>
      {asset.drift ? (
        <span className="flex items-baseline gap-(--space-xs) type-xs">
          <Dot tone="warning" className="translate-y-[-1px]" />
          {asset.drift}
        </span>
      ) : null}
    </div>,
    <span key="tier" className="whitespace-nowrap">
      {asset.tier}
    </span>,
    <Tag key="access">{asset.access}</Tag>,
    <Muted key="because" className="block min-w-[200px]">
      {asset.accessBecause}
    </Muted>,
    <div key="proof" className="flex min-w-[200px] flex-col gap-(--space-xxs)">
      <span className="flex items-baseline gap-(--space-xs)">
        <Dot tone={asset.proof.ok ? "success" : "warning"} className="translate-y-[-1px]" />
        {asset.proof.kind}
      </span>
      {asset.proof.ok ? null : <Muted className="type-xs">{pick(BEFORE_PROOF, BEFORE_PROOF_TECHNICAL)}</Muted>}
    </div>,
  ]
}
