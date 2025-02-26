import { t } from "@lingui/macro";

import { CSSResult, LitElement, TemplateResult, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { until } from "lit/directives/until.js";

import AKGlobal from "../authentik.css";
import PFBackgroundImage from "@patternfly/patternfly/components/BackgroundImage/background-image.css";
import PFButton from "@patternfly/patternfly/components/Button/button.css";
import PFDrawer from "@patternfly/patternfly/components/Drawer/drawer.css";
import PFList from "@patternfly/patternfly/components/List/list.css";
import PFLogin from "@patternfly/patternfly/components/Login/login.css";
import PFTitle from "@patternfly/patternfly/components/Title/title.css";
import PFBase from "@patternfly/patternfly/patternfly-base.css";

import {
    ChallengeChoices,
    ChallengeTypes,
    CurrentTenant,
    FlowChallengeResponseRequest,
    FlowsApi,
    RedirectChallenge,
    ShellChallenge,
} from "@goauthentik/api";

import { DEFAULT_CONFIG, tenant } from "../api/Config";
import { configureSentry } from "../api/Sentry";
import { WebsocketClient } from "../common/ws";
import { EVENT_FLOW_ADVANCE, TITLE_DEFAULT } from "../constants";
import "../elements/LoadingOverlay";
import { first } from "../utils";
import "./FlowInspector";
import "./access_denied/FlowAccessDenied";
import "./sources/plex/PlexLoginInit";
import "./stages/RedirectStage";
import "./stages/authenticator_duo/AuthenticatorDuoStage";
import "./stages/authenticator_sms/AuthenticatorSMSStage";
import "./stages/authenticator_static/AuthenticatorStaticStage";
import "./stages/authenticator_totp/AuthenticatorTOTPStage";
import "./stages/authenticator_validate/AuthenticatorValidateStage";
import "./stages/authenticator_webauthn/WebAuthnAuthenticatorRegisterStage";
import "./stages/autosubmit/AutosubmitStage";
import { StageHost } from "./stages/base";
import "./stages/captcha/CaptchaStage";
import "./stages/consent/ConsentStage";
import "./stages/dummy/DummyStage";
import "./stages/email/EmailStage";
import "./stages/identification/IdentificationStage";
import "./stages/password/PasswordStage";
import "./stages/prompt/PromptStage";

@customElement("ak-flow-executor")
export class FlowExecutor extends LitElement implements StageHost {
    flowSlug: string;

    private _challenge?: ChallengeTypes;

    @property({ attribute: false })
    set challenge(value: ChallengeTypes | undefined) {
        this._challenge = value;
        // Assign the location as soon as we get the challenge and *not* in the render function
        // as the render function might be called multiple times, which will navigate multiple
        // times and can invalidate oauth codes
        // Also only auto-redirect when the inspector is open, so that a user can inspect the
        // redirect in the inspector
        if (value?.type === ChallengeChoices.Redirect && !this.inspectorOpen) {
            console.debug(
                "authentik/flows: redirecting to url from server",
                (value as RedirectChallenge).to,
            );
            window.location.assign((value as RedirectChallenge).to);
        }
        tenant().then((tenant) => {
            if (value?.flowInfo?.title) {
                document.title = `${value.flowInfo?.title} - ${tenant.brandingTitle}`;
            } else {
                document.title = tenant.brandingTitle || TITLE_DEFAULT;
            }
        });
        this.requestUpdate();
    }

    get challenge(): ChallengeTypes | undefined {
        return this._challenge;
    }

    @property({ type: Boolean })
    loading = false;

    @property({ attribute: false })
    tenant?: CurrentTenant;

    @property({ attribute: false })
    inspectorOpen: boolean;

    ws: WebsocketClient;

    static get styles(): CSSResult[] {
        return [PFBase, PFLogin, PFDrawer, PFButton, PFTitle, PFList, PFBackgroundImage, AKGlobal]
            .concat(css`
            .ak-hidden {
                display: none;
            }
            :host {
                position: relative;
            }
            .ak-exception {
                font-family: monospace;
                overflow-x: scroll;
            }
            .pf-c-drawer__content {
                background-color: transparent;
            }
        `);
    }

    constructor() {
        super();
        this.ws = new WebsocketClient();
        this.flowSlug = window.location.pathname.split("/")[3];
        this.inspectorOpen = window.location.search.includes("inspector");
    }

    setBackground(url: string): void {
        this.shadowRoot
            ?.querySelectorAll<HTMLDivElement>(".pf-c-background-image")
            .forEach((bg) => {
                bg.style.setProperty("--ak-flow-background", `url('${url}')`);
            });
    }

    submit(payload?: FlowChallengeResponseRequest): Promise<void> {
        if (!payload) return Promise.reject();
        if (!this.challenge) return Promise.reject();
        // @ts-ignore
        payload.component = this.challenge.component;
        this.loading = true;
        return new FlowsApi(DEFAULT_CONFIG)
            .flowsExecutorSolve({
                flowSlug: this.flowSlug,
                query: window.location.search.substring(1),
                flowChallengeResponseRequest: payload,
            })
            .then((data) => {
                if (this.inspectorOpen) {
                    window.dispatchEvent(
                        new CustomEvent(EVENT_FLOW_ADVANCE, {
                            bubbles: true,
                            composed: true,
                        }),
                    );
                }
                this.challenge = data;
            })
            .catch((e: Error | Response) => {
                this.errorMessage(e);
            })
            .finally(() => {
                this.loading = false;
            });
    }

    firstUpdated(): void {
        configureSentry();
        tenant().then((tenant) => (this.tenant = tenant));
        this.loading = true;
        new FlowsApi(DEFAULT_CONFIG)
            .flowsExecutorGet({
                flowSlug: this.flowSlug,
                query: window.location.search.substring(1),
            })
            .then((challenge) => {
                if (this.inspectorOpen) {
                    window.dispatchEvent(
                        new CustomEvent(EVENT_FLOW_ADVANCE, {
                            bubbles: true,
                            composed: true,
                        }),
                    );
                }
                this.challenge = challenge;
                // Only set background on first update, flow won't change throughout execution
                if (this.challenge?.flowInfo?.background) {
                    this.setBackground(this.challenge.flowInfo.background);
                }
            })
            .catch((e: Error | Response) => {
                // Catch JSON or Update errors
                this.errorMessage(e);
            })
            .finally(() => {
                this.loading = false;
            });
    }

    async errorMessage(error: Error | Response): Promise<void> {
        let body = "";
        if (error instanceof Error) {
            body = error.message;
        }
        this.challenge = {
            type: ChallengeChoices.Shell,
            body: `<header class="pf-c-login__main-header">
                <h1 class="pf-c-title pf-m-3xl">
                    ${t`Whoops!`}
                </h1>
            </header>
            <div class="pf-c-login__main-body">
                <h3>${t`Something went wrong! Please try again later.`}</h3>
                <pre class="ak-exception">${body}</pre>
            </div>
            <footer class="pf-c-login__main-footer">
                <ul class="pf-c-login__main-footer-links">
                    <li class="pf-c-login__main-footer-links-item">
                        <a class="pf-c-button pf-m-primary pf-m-block" href="/">
                            ${t`Return`}
                        </a>
                    </li>
                </ul>
            </footer>`,
        } as ChallengeTypes;
    }

    renderChallenge(): TemplateResult {
        if (!this.challenge) {
            return html``;
        }
        switch (this.challenge.type) {
            case ChallengeChoices.Redirect:
                if (this.inspectorOpen) {
                    return html`<ak-stage-redirect
                        .host=${this as StageHost}
                        .challenge=${this.challenge}
                    >
                    </ak-stage-redirect>`;
                }
                return html`<ak-empty-state ?loading=${true} header=${t`Loading`}>
                </ak-empty-state>`;
            case ChallengeChoices.Shell:
                return html`${unsafeHTML((this.challenge as ShellChallenge).body)}`;
            case ChallengeChoices.Native:
                switch (this.challenge.component) {
                    case "ak-stage-access-denied":
                        return html`<ak-stage-access-denied
                            .host=${this as StageHost}
                            .challenge=${this.challenge}
                        ></ak-stage-access-denied>`;
                    case "ak-stage-identification":
                        return html`<ak-stage-identification
                            .host=${this as StageHost}
                            .challenge=${this.challenge}
                        ></ak-stage-identification>`;
                    case "ak-stage-password":
                        return html`<ak-stage-password
                            .host=${this as StageHost}
                            .challenge=${this.challenge}
                        ></ak-stage-password>`;
                    case "ak-stage-captcha":
                        return html`<ak-stage-captcha
                            .host=${this as StageHost}
                            .challenge=${this.challenge}
                        ></ak-stage-captcha>`;
                    case "ak-stage-consent":
                        return html`<ak-stage-consent
                            .host=${this as StageHost}
                            .challenge=${this.challenge}
                        ></ak-stage-consent>`;
                    case "ak-stage-dummy":
                        return html`<ak-stage-dummy
                            .host=${this as StageHost}
                            .challenge=${this.challenge}
                        ></ak-stage-dummy>`;
                    case "ak-stage-email":
                        return html`<ak-stage-email
                            .host=${this as StageHost}
                            .challenge=${this.challenge}
                        ></ak-stage-email>`;
                    case "ak-stage-autosubmit":
                        return html`<ak-stage-autosubmit
                            .host=${this as StageHost}
                            .challenge=${this.challenge}
                        ></ak-stage-autosubmit>`;
                    case "ak-stage-prompt":
                        return html`<ak-stage-prompt
                            .host=${this as StageHost}
                            .challenge=${this.challenge}
                        ></ak-stage-prompt>`;
                    case "ak-stage-authenticator-totp":
                        return html`<ak-stage-authenticator-totp
                            .host=${this as StageHost}
                            .challenge=${this.challenge}
                        ></ak-stage-authenticator-totp>`;
                    case "ak-stage-authenticator-duo":
                        return html`<ak-stage-authenticator-duo
                            .host=${this as StageHost}
                            .challenge=${this.challenge}
                        ></ak-stage-authenticator-duo>`;
                    case "ak-stage-authenticator-static":
                        return html`<ak-stage-authenticator-static
                            .host=${this as StageHost}
                            .challenge=${this.challenge}
                        ></ak-stage-authenticator-static>`;
                    case "ak-stage-authenticator-webauthn":
                        return html`<ak-stage-authenticator-webauthn
                            .host=${this as StageHost}
                            .challenge=${this.challenge}
                        ></ak-stage-authenticator-webauthn>`;
                    case "ak-stage-authenticator-validate":
                        return html`<ak-stage-authenticator-validate
                            .host=${this as StageHost}
                            .challenge=${this.challenge}
                        ></ak-stage-authenticator-validate>`;
                    case "ak-stage-authenticator-sms":
                        return html`<ak-stage-authenticator-sms
                            .host=${this as StageHost}
                            .challenge=${this.challenge}
                        ></ak-stage-authenticator-sms>`;
                    case "ak-flow-sources-plex":
                        return html`<ak-flow-sources-plex
                            .host=${this as StageHost}
                            .challenge=${this.challenge}
                        ></ak-flow-sources-plex>`;
                    default:
                        break;
                }
                break;
            default:
                console.debug(`authentik/flows: unexpected data type ${this.challenge.type}`);
                break;
        }
        return html``;
    }

    renderChallengeWrapper(): TemplateResult {
        if (!this.challenge) {
            return html`<ak-empty-state ?loading=${true} header=${t`Loading`}> </ak-empty-state>`;
        }
        return html`
            ${this.loading ? html`<ak-loading-overlay></ak-loading-overlay>` : html``}
            ${this.renderChallenge()}
        `;
    }

    render(): TemplateResult {
        return html`<div class="pf-c-background-image">
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    class="pf-c-background-image__filter"
                    width="0"
                    height="0"
                >
                    <filter id="image_overlay">
                        <feColorMatrix
                            in="SourceGraphic"
                            type="matrix"
                            values="1.3 0 0 0 0 0 1.3 0 0 0 0 0 1.3 0 0 0 0 0 1 0"
                        />
                        <feComponentTransfer color-interpolation-filters="sRGB" result="duotone">
                            <feFuncR
                                type="table"
                                tableValues="0.086274509803922 0.43921568627451"
                            ></feFuncR>
                            <feFuncG
                                type="table"
                                tableValues="0.086274509803922 0.43921568627451"
                            ></feFuncG>
                            <feFuncB
                                type="table"
                                tableValues="0.086274509803922 0.43921568627451"
                            ></feFuncB>
                            <feFuncA type="table" tableValues="0 1"></feFuncA>
                        </feComponentTransfer>
                    </filter>
                </svg>
            </div>
            <div class="pf-c-page__drawer">
                <div class="pf-c-drawer ${this.inspectorOpen ? "pf-m-expanded" : "pf-m-collapsed"}">
                    <div class="pf-c-drawer__main">
                        <div class="pf-c-drawer__content">
                            <div class="pf-c-drawer__body">
                                <div class="pf-c-login">
                                    <div class="ak-login-container">
                                        <header class="pf-c-login__header">
                                            <div class="pf-c-brand ak-brand">
                                                <img
                                                    src="${first(this.tenant?.brandingLogo, "")}"
                                                />
                                            </div>
                                        </header>
                                        <div class="pf-c-login__main">
                                            ${this.renderChallengeWrapper()}
                                        </div>
                                        <footer class="pf-c-login__footer">
                                            <p></p>
                                            <ul class="pf-c-list pf-m-inline">
                                                ${until(
                                                    this.tenant?.uiFooterLinks?.map((link) => {
                                                        return html`<li>
                                                            <a href="${link.href || ""}"
                                                                >${link.name}</a
                                                            >
                                                        </li>`;
                                                    }),
                                                )}
                                                ${this.tenant?.brandingTitle != "authentik"
                                                    ? html`
                                                          <li>
                                                              <a
                                                                  href="https://goauthentik.io?utm_source=authentik&amp;utm_medium=flow"
                                                                  >${t`Powered by authentik`}</a
                                                              >
                                                          </li>
                                                      `
                                                    : html``}
                                                ${this.challenge?.flowInfo?.background?.startsWith(
                                                    "/static",
                                                )
                                                    ? html`
                                                          <li>
                                                              <a href="https://unsplash.com/@foxxmd"
                                                                  >${t`Background image`}</a
                                                              >
                                                          </li>
                                                      `
                                                    : html``}
                                            </ul>
                                        </footer>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <ak-flow-inspector
                            class="pf-c-drawer__panel pf-m-width-33 ${this.inspectorOpen
                                ? ""
                                : "display-none"}"
                            ?hidden=${!this.inspectorOpen}
                        ></ak-flow-inspector>
                    </div>
                </div>
            </div>`;
    }
}
