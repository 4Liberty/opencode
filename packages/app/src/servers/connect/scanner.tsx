import QrScanner from "qr-scanner"
import { onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode/ui/button"
import { useLanguage } from "@/runtime/i18n/language"
import { pairingLink, redeemPairingLink, type Pairing } from "./pairing"
import { isMixedContent } from "./browser"
import "./scanner.css"

export function PairingScanner(props: { onScan: (value: Pairing) => void; onCancel: () => void }) {
  const language = useLanguage()
  const [state, setState] = createStore({ error: "", ready: false, paused: false })
  const video = document.createElement("video")
  video.setAttribute("aria-label", language.t("server.connect.camera"))
  video.setAttribute("playsinline", "")
  video.muted = true
  let scanner: QrScanner | undefined

  const start = () => {
    setState({ error: "", ready: false, paused: false })
    void scanner?.start().then(
      () => setState("ready", true),
      () => setState({ error: language.t("server.connect.camera.error"), paused: true }),
    )
  }

  onMount(() => {
    // QrScanner hides detached videos, so initialize only after this preview is mounted.
    const instance = new QrScanner(
      video,
      (result) => {
        const link = pairingLink(result.data)
        if (!link) {
          setState("error", language.t("server.connect.scan.invalid"))
          return
        }
        scanner?.stop()
        void redeemPairingLink(link).then((redeemed) => {
          if (redeemed.ok) return props.onScan(redeemed.pairing)
          setState({
            error: language.t(
              redeemed.reason === "expired"
                ? "server.connect.link.expired"
                : isMixedContent(location.href, link.url)
                  ? "server.connect.mixedContent"
                  : "server.connect.link.failed",
            ),
            paused: true,
          })
        })
      },
      { preferredCamera: "environment", maxScansPerSecond: 10, returnDetailedScanResult: true },
    )
    scanner = instance
    // Terminal QR codes can be light-on-dark depending on the terminal theme.
    instance.setInversionMode("both")
    onCleanup(() => instance.destroy())
    start()
  })

  return (
    <section class="server-connect-scanner" aria-label={language.t("server.connect.scan")}>
      <Show
        when={!state.paused}
        fallback={
          <div class="server-connect-scan-alert" role="alert">
            <p class="server-connect-error">{state.error}</p>
            <Button variant="contrast" size="large" onClick={start}>
              {language.t("common.retry")}
            </Button>
          </div>
        }
      >
        <p>{language.t("server.connect.scan.description")}</p>
        <div class="server-connect-video">
          {video}
          <Show when={!state.ready && !state.error}>
            <span role="status">{language.t("server.connect.camera.starting")}</span>
          </Show>
        </div>
        <Show when={state.error}>
          <p class="server-connect-error" role="alert">
            {state.error}
          </p>
        </Show>
      </Show>
      <Button variant="neutral" size="large" onClick={props.onCancel}>
        {language.t("common.cancel")}
      </Button>
    </section>
  )
}
