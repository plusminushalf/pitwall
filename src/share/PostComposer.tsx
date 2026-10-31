// A post written as an image (C): a title and some text, on a card like a widget's share card (ShareCard.tsx), for
// the words that go with no chart. What's typed shows as the card will, and ⌘ / Ctrl + Enter copies it.

import { useEffect, useRef } from "react"
import { siteOrigin } from "./link"
import { CARD_WIDTH, CardFooter, CardHeading } from "./ShareCard"
import { Kbd, useShare } from "./ShareShot"

/** A post's text on its card: a blank line starts a paragraph, a single one breaks the line. */
export function PostText({ text }: { text: string }) {
    return (
        <div className="whitespace-pre-wrap text-lg leading-relaxed text-zinc-200">
            {text}
        </div>
    )
}

/** The key held with Enter to copy: ⌘ on a Mac, else Ctrl. */
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"

const FIELD =
    "w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"

export function PostComposer() {
    const draft = useShare((s) => s.draft)
    const { setDraft, post, cancel } = useShare.getState()
    const titleRef = useRef<HTMLInputElement>(null)
    const textRef = useRef<HTMLTextAreaElement>(null)
    const empty = !draft.title.trim() && !draft.text.trim()

    useEffect(() => titleRef.current?.focus(), [])

    // biome-ignore lint/correctness/useExhaustiveDependencies: the draft is read from the store when the key comes
    useEffect(() => {
        // Before the replay's keys (window, bubbling), and in the fields too.
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") cancel()
            else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                const { title, text } = useShare.getState().draft
                if (title.trim() || text.trim()) post(title, text)
            } else return
            e.preventDefault()
            e.stopPropagation()
        }
        window.addEventListener("keydown", onKey, true)
        return () => window.removeEventListener("keydown", onKey, true)
    }, [])

    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop's click closes it, as Esc does
        // biome-ignore lint/a11y/useKeyWithClickEvents: Esc is on the window's keydown listener above
        <div
            data-shot-ignore=""
            className="fixed inset-0 z-50 flex items-center justify-center overflow-auto bg-black/60 p-6"
            onClick={(e) => e.target === e.currentTarget && cancel()}
        >
            <div
                role="dialog"
                aria-label="Write a post"
                className="flex max-h-full gap-6 rounded-lg border border-zinc-800 bg-zinc-900 p-5 shadow-2xl"
            >
                <div className="flex w-80 shrink-0 flex-col gap-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                        Write a post
                    </p>
                    <input
                        ref={titleRef}
                        value={draft.title}
                        onChange={(e) =>
                            setDraft({ ...draft, title: e.target.value })
                        }
                        onKeyDown={(e) => {
                            if (e.key !== "Enter" || e.metaKey || e.ctrlKey)
                                return
                            e.preventDefault()
                            textRef.current?.focus()
                        }}
                        placeholder="Title"
                        aria-label="Title"
                        className={`${FIELD} font-semibold`}
                    />
                    <textarea
                        ref={textRef}
                        value={draft.text}
                        onChange={(e) =>
                            setDraft({ ...draft, text: e.target.value })
                        }
                        placeholder="What you want to say"
                        aria-label="Description"
                        rows={10}
                        className={`${FIELD} resize-none leading-relaxed`}
                    />
                    <div className="mt-auto flex items-center gap-2 text-xs text-zinc-400">
                        <button
                            type="button"
                            disabled={empty}
                            onClick={() => post(draft.title, draft.text)}
                            className="flex items-center gap-1.5 rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-900 hover:bg-white disabled:opacity-40"
                        >
                            Copy image
                        </button>
                        <Kbd>{`${MOD} Enter`}</Kbd>
                        <span className="flex-1" />
                        <button
                            type="button"
                            onClick={cancel}
                            className="rounded-md px-2 py-1.5 font-semibold hover:bg-zinc-800 hover:text-zinc-100"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
                {/* The card as it'll be drawn (ShareCard.tsx), at its size on the page. */}
                <div
                    className="shrink-0 self-start overflow-hidden border border-zinc-800 bg-zinc-950 px-6 pb-5 pt-6 text-zinc-100"
                    style={{ width: CARD_WIDTH }}
                >
                    {draft.title.trim() && (
                        <CardHeading heading={{ title: draft.title.trim() }} />
                    )}
                    {draft.text ? (
                        <PostText text={draft.text} />
                    ) : (
                        <p className="text-lg text-zinc-600">
                            Your text shows here
                        </p>
                    )}
                    <CardFooter credits="" host={new URL(siteOrigin()).host} />
                </div>
            </div>
        </div>
    )
}
