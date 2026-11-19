package com.whaleonebot.ui;

/**
 * 模型与 Key 面板的<b>静态数据表</b>：渠道预置（46 条）+ 思考档位（9 条）+ 查询方法。
 *
 * <p><b>Android-free</b>：本类不 import 任何 {@code android.*}，只用 JDK，可用纯 JVM 编译 / 自检。
 * 语言级别为 Java 8（工程用 {@code javac --release 8} 编译）。
 *
 * <p><b>数据来源</b>（生成，勿手改；改数据请改来源后重跑生成器）：
 * <ul>
 *   <li>渠道预置 46 条 ← Alkaid {@code app/release/stage/src/core/model/presets.json}
 *       （只取 id / displayName / endpoints[{label,baseUrl,recommended}] / commonModels /
 *       sessionHeaderName / docUrl / note；endpoint 的 note 与整个 defaultHeaders 不引入）。</li>
 *   <li>思考档位 9 条 ← 运行端 {@code src/core/provider-presets.js} 的 {@code MODEL_SERVICES}
 *       （只取 id / label / hosts / thinking.uiLevels）。</li>
 * </ul>
 * 两份数据都不含 API Key，本类也不接受、不保存任何 Key。
 *
 * <p><b>与本面板合同的一处笔误</b>：合同 §4 把最后一个方法写成
 * {@code levelsFor(BaseUrl)}（形参缺类型），本类按 {@code levelsFor(String baseUrl)} 实现，
 * 语义与该合同一致。
 *
 * <p><b>hostOf 口径</b>：取 URL 的主机名 —— 去掉协议、userinfo、<b>端口</b>、路径 / 查询 / 片段，
 * 再转小写。注意运行端 JS 的 {@code hostOf} 用 {@code new URL(u).host}，会<b>保留端口</b>
 * （{@code api.deepseek.com:8080}）；本表按面板合同要求去掉端口后再比对，因此
 * {@code https://api.deepseek.com:8080} 也能匹配到 deepseek。
 *
 * <p><b>档位口径</b>：{@code uiLevels} 是该供应商真正认的档位，<b>可能没有 off</b>
 * （opencode / commandcode 就没有，这是对的，不要补）；{@code custom} 的 hosts 与 uiLevels
 * 都是空数组（= 表外，没有档位预设）。档位按「供应商(host) + 用途」保存，运行端不支持按单个模型设。
 */
public final class ModelPresets {

    private ModelPresets() {
    }

    /** 预置里的一个接入点。 */
    public static final class Endpoint {
        public final String label;
        public final String baseUrl;
        public final boolean recommended;

        public Endpoint(String label, String baseUrl, boolean recommended) {
            this.label = label == null ? "" : label;
            this.baseUrl = baseUrl == null ? "" : baseUrl;
            this.recommended = recommended;
        }
    }

    /** 一条渠道预置。 */
    public static final class Provider {
        public final String id;
        public final String label;
        public final String docUrl;
        public final String note;
        public final String sessionHeader;
        public final Endpoint[] endpoints;
        public final String[] commonModels;

        public Provider(String id, String label, String docUrl, String note, String sessionHeader,
                        Endpoint[] endpoints, String[] commonModels) {
            this.id = id == null ? "" : id;
            this.label = label == null ? "" : label;
            this.docUrl = docUrl == null ? "" : docUrl;
            this.note = note == null ? "" : note;
            this.sessionHeader = sessionHeader == null ? "" : sessionHeader;
            this.endpoints = endpoints == null ? new Endpoint[0] : endpoints;
            this.commonModels = commonModels == null ? new String[0] : commonModels;
        }
    }

    /** 一条思考档位服务（按供应商 / host 生效）。 */
    public static final class Service {
        public final String id;
        public final String label;
        public final String[] hosts;
        public final String[] uiLevels;

        public Service(String id, String label, String[] hosts, String[] uiLevels) {
            this.id = id == null ? "" : id;
            this.label = label == null ? "" : label;
            this.hosts = hosts == null ? new String[0] : hosts;
            this.uiLevels = uiLevels == null ? new String[0] : uiLevels;
        }
    }

    // ---------------- 生成的字面量（46 条预置 + 58 个接入点） ----------------

    private static final Provider[] PROVIDERS = new Provider[] {
        pv("deepseek", "DeepSeek", "https://platform.deepseek.com/api_keys", "另有 Anthropic 兼容端点 /anthropic（本项目不用）", "",
        new Endpoint[] {
            ep("官方", "https://api.deepseek.com", true)
        },
        strs("deepseek-flash", "deepseek-v4-pro")),
        pv("moonshotai", "Kimi（月之暗面）", "https://platform.kimi.com/docs/api/chat", "Key 与国内站不通用", "",
        new Endpoint[] {
            ep("国内站", "https://api.moonshot.cn/v1", true),
            ep("国际站", "https://api.moonshot.ai/v1", false)
        },
        strs("kimi-k3.1-pro", "moonshot-v1-auto")),
        pv("kimi-coding", "Kimi 编程套餐", "https://platform.kimi.com/", "套餐专用端点，与按量计费的 Key 不通用", "",
        new Endpoint[] {
            ep("Coding", "https://api.kimi.com/coding/v1", true)
        },
        strs()),
        pv("qwen", "通义千问（阿里云百炼）", "https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope", "套餐制，用套餐 Key", "",
        new Endpoint[] {
            ep("Token Plan（新加坡）", "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", true),
            ep("Token Plan（北京）", "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", false),
            ep("API 直连（北京，业务空间）", "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", false),
            ep("API 直连（北京，旧域名）", "https://dashscope.aliyuncs.com/compatible-mode/v1", false),
            ep("API 直连（新加坡）", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", false)
        },
        strs("qwen3.8-max", "qwen-plus", "qwen-max")),
        pv("zai", "智谱 GLM", "https://docs.bigmodel.cn/cn/guide/start/introduction", "bigmodel.cn，编程套餐专用路径", "",
        new Endpoint[] {
            ep("国内编程套餐", "https://open.bigmodel.cn/api/coding/paas/v4", true),
            ep("国际站", "https://api.z.ai/api/coding/paas/v4", false),
            ep("标准 API（国内）", "https://open.bigmodel.cn/api/paas/v4", false)
        },
        strs("glm-5.3", "glm-5.3-flash", "glm-4-plus")),
        pv("xiaomi", "小米 MiMo", "https://platform.xiaomimimo.com/", "套餐制", "",
        new Endpoint[] {
            ep("API 直连", "https://api.xiaomimimo.com/v1", true),
            ep("Token Plan（中国）", "https://token-plan-cn.xiaomimimo.com/v1", false),
            ep("Token Plan（新加坡）", "https://token-plan-sgp.xiaomimimo.com/v1", false),
            ep("Token Plan（阿姆斯特丹）", "https://token-plan-ams.xiaomimimo.com/v1", false)
        },
        strs()),
        pv("minimax", "MiniMax", "", "★ DSH 里记的是 Anthropic 端点，OpenAI 兼容请自行确认", "",
        new Endpoint[] {
            ep("国际站", "https://api.minimax.io/anthropic", false),
            ep("国内站", "https://api.minimaxi.com/anthropic", false)
        },
        strs()),
        pv("siliconflow", "硅基流动", "https://docs.siliconflow.cn/docs/api/chat-completions-post", "聚合平台，模型名带组织前缀", "",
        new Endpoint[] {
            ep("官方", "https://api.siliconflow.cn/v1", true)
        },
        strs("deepseek-ai/DeepSeek-V4-Flash", "moonshotai/Kimi-K2.7-Code", "Qwen/Qwen3-235B")),
        pv("openai", "OpenAI", "https://platform.openai.com/api-keys", "★ Chat Completions 不返回推理内容；推理走 Responses API（未接）", "",
        new Endpoint[] {
            ep("官方", "https://api.openai.com/v1", true)
        },
        strs("gpt-4o", "gpt-4o-mini", "o3")),
        pv("openrouter", "OpenRouter", "https://openrouter.ai/docs/quickstart", "聚合平台；推理字段归一化成 reasoning + reasoning_details", "",
        new Endpoint[] {
            ep("官方", "https://openrouter.ai/api/v1", true)
        },
        strs("openai/gpt-4o", "anthropic/claude-sonnet-4", "google/gemini-2.5-pro", "deepseek/deepseek-chat")),
        pv("groq", "Groq", "https://console.groq.com/docs/openai", "以推理速度著称", "",
        new Endpoint[] {
            ep("官方", "https://api.groq.com/openai/v1", true)
        },
        strs()),
        pv("xai", "xAI Grok", "https://docs.x.ai/", "", "",
        new Endpoint[] {
            ep("官方", "https://api.x.ai/v1", true)
        },
        strs("grok-4", "grok-3")),
        pv("mistral", "Mistral", "https://docs.mistral.ai/", "", "",
        new Endpoint[] {
            ep("官方", "https://api.mistral.ai/v1", true)
        },
        strs()),
        pv("together", "Together AI", "https://docs.together.ai/", "", "",
        new Endpoint[] {
            ep("官方", "https://api.together.ai/v1", true)
        },
        strs()),
        pv("fireworks", "Fireworks AI", "https://docs.fireworks.ai/", "", "",
        new Endpoint[] {
            ep("官方", "https://api.fireworks.ai/inference/v1", true)
        },
        strs()),
        pv("cerebras", "Cerebras", "https://inference-docs.cerebras.ai/", "", "",
        new Endpoint[] {
            ep("官方", "https://api.cerebras.ai/v1", true)
        },
        strs()),
        pv("huggingface", "Hugging Face", "https://huggingface.co/docs/inference-providers", "", "",
        new Endpoint[] {
            ep("Router", "https://router.huggingface.co/v1", true)
        },
        strs()),
        pv("vercel-ai-gateway", "Vercel AI Gateway", "https://vercel.com/docs/ai-gateway", "", "",
        new Endpoint[] {
            ep("官方", "https://ai-gateway.vercel.sh/v1", true)
        },
        strs()),
        pv("baseten", "Baseten", "", "", "",
        new Endpoint[] {
            ep("官方", "https://inference.baseten.co/v1", true)
        },
        strs()),
        pv("nvidia", "NVIDIA NIM", "https://build.nvidia.com/", "", "",
        new Endpoint[] {
            ep("官方", "https://integrate.api.nvidia.com/v1", true)
        },
        strs()),
        pv("ollama", "Ollama（本地）", "https://github.com/ollama/ollama/blob/main/docs/openai.md", "需在 network_security_config 放行明文", "",
        new Endpoint[] {
            ep("本机", "http://127.0.0.1:11434/v1", true),
            ep("局域网另一台机器", "http://192.168.1.x:11434/v1", false)
        },
        strs("llama3.2", "qwen2.5", "deepseek-r1")),
        pv("lmstudio", "LM Studio（本地）", "https://lmstudio.ai/docs/api/openai-api", "需放行明文", "",
        new Endpoint[] {
            ep("本机", "http://127.0.0.1:1234/v1", false)
        },
        strs()),
        pv("ant-ling", "蚂蚁百灵", "", "OpenAI 兼容", "",
        new Endpoint[] {
            ep("官方", "https://api.ant-ling.com/v1", true)
        },
        strs()),
        pv("anthropic", "Anthropic（Claude）", "", "★ 原生 Messages 协议，本版未实现，会提示不支持；如需可用请走自定义 API 填兼容网关", "",
        new Endpoint[] {
            ep("官方", "https://api.anthropic.com", true)
        },
        strs()),
        pv("github-copilot", "GitHub Copilot", "", "需要 Copilot 订阅签发的 token，不是普通 API Key", "",
        new Endpoint[] {
            ep("个人版", "https://api.individual.githubcopilot.com", true)
        },
        strs()),
        pv("google", "Google（Gemini）", "", "★ 原生 generateContent 协议，本版未实现；如需可用请走自定义 API 填兼容网关", "",
        new Endpoint[] {
            ep("官方", "https://generativelanguage.googleapis.com/v1beta", true)
        },
        strs()),
        pv("meta", "Meta", "", "OpenAI 兼容", "",
        new Endpoint[] {
            ep("官方", "https://api.meta.ai/v1", true)
        },
        strs()),
        pv("minimax-cn", "MiniMax（国内站）", "", "需兼容网关或客户端支持", "",
        new Endpoint[] {
            ep("Anthropic 兼容", "https://api.minimaxi.com/anthropic", false)
        },
        strs()),
        pv("moonshotai-cn", "Kimi（国内站 .cn）", "", "★ 与 .ai 站的 Key 不通用", "",
        new Endpoint[] {
            ep("国内站", "https://api.moonshot.cn/v1", true)
        },
        strs("kimi-k2-0905-preview", "moonshot-v1-128k")),
        pv("openai-codex", "OpenAI Codex", "", "★ 走 ChatGPT 订阅登录态，不是 API Key，本版未实现", "",
        new Endpoint[] {
            ep("ChatGPT 后端", "https://chatgpt.com/backend-api", false)
        },
        strs()),
        pv("qwen-token-plan", "通义 Token Plan（新加坡）", "", "★ 套餐 Key 与按量计费 Key 不通用；区域绑错会 401", "",
        new Endpoint[] {
            ep("新加坡", "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", true)
        },
        strs("qwen3-max", "qwen-plus")),
        pv("qwen-token-plan-cn", "通义 Token Plan（北京）", "", "★ 套餐 Key 与按量计费 Key 不通用；区域绑错会 401", "",
        new Endpoint[] {
            ep("北京", "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", true)
        },
        strs("qwen3-max", "qwen-plus")),
        pv("radius", "Radius", "", "OpenAI 兼容", "",
        new Endpoint[] {
            ep("官方", "https://radius.pi.dev/v1", true)
        },
        strs()),
        pv("xiaomi-token-plan-ams", "小米 Token Plan（阿姆斯特丹）", "", "★ Token Plan 走独立域名，套餐 Key 与按量 Key 不通用", "",
        new Endpoint[] {
            ep("阿姆斯特丹", "https://token-plan-ams.xiaomimimo.com/v1", true)
        },
        strs()),
        pv("xiaomi-token-plan-cn", "小米 Token Plan（国内）", "", "★ Token Plan 走独立域名，套餐 Key 与按量 Key 不通用", "",
        new Endpoint[] {
            ep("国内", "https://token-plan-cn.xiaomimimo.com/v1", true)
        },
        strs()),
        pv("xiaomi-token-plan-sgp", "小米 Token Plan（新加坡）", "", "★ Token Plan 走独立域名，套餐 Key 与按量 Key 不通用", "",
        new Endpoint[] {
            ep("新加坡", "https://token-plan-sgp.xiaomimimo.com/v1", true)
        },
        strs()),
        pv("zai-coding-cn", "智谱 Coding Plan（国内）", "", "★ Coding Plan 与普通 API Key 不通用", "",
        new Endpoint[] {
            ep("国内", "https://open.bigmodel.cn/api/coding/paas/v4", true)
        },
        strs()),
        pv("custom", "自定义", "", "任何 OpenAI 兼容的 base URL", "",
        new Endpoint[] {
            ep("手动填写", "", false)
        },
        strs()),
        pv("opencode", "OpenCode Zen（按量计费）", "", "★ 套餐（Go）与按量计费的 Key 不通用，别选错接入点", "x-opencode-session",
        new Endpoint[] {
            ep("按量计费", "https://opencode.ai/inference/openai/v1", true)
        },
        strs("deepseek-v4.1-flash", "glm-5.3", "kimi-k3", "qwen3.8-max")),
        pv("opencode-go", "OpenCode Go（订阅）", "", "★ 需要 Go 订阅；与按量计费的 Key 不通用", "x-opencode-session",
        new Endpoint[] {
            ep("Go 订阅", "https://opencode.ai/inference/go/openai/v1", true)
        },
        strs("deepseek-v4.1-flash", "glm-5.3", "kimi-k3")),
        pv("cloudflare-workers-ai", "Cloudflare Workers AI", "", "★ 把 {account_id} 换成你的 Cloudflare 账户 ID", "",
        new Endpoint[] {
            ep("账户级", "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1", true)
        },
        strs("@cf/meta/llama-3.1-8b-instruct")),
        pv("cloudflare-ai-gateway", "Cloudflare AI Gateway", "", "★ 把 {account_id} / {gateway_id} 换成你自己的；网关需先在 CF 后台建好", "",
        new Endpoint[] {
            ep("网关", "https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat", true)
        },
        strs()),
        pv("google-vertex", "Google Vertex AI", "", "★ 替换 {region} 与 {project}；鉴权走 Google 凭据，不是普通 API Key", "",
        new Endpoint[] {
            ep("OpenAI 兼容", "https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{region}/endpoints/openapi", true)
        },
        strs()),
        pv("amazon-bedrock", "Amazon Bedrock", "", "★ 替换 {region}；鉴权用 AWS SigV4（不是 Bearer Key），本版不支持签名", "",
        new Endpoint[] {
            ep("OpenAI 兼容", "https://bedrock-runtime.{region}.amazonaws.com/openai/v1", true)
        },
        strs()),
        pv("azure", "Azure OpenAI", "", "★ 路径与鉴权头都非标准（api-key + api-version），本版未实现；建议走自定义网关", "",
        new Endpoint[] {
            ep("资源级", "https://{resource}.openai.azure.com/openai/deployments/{deployment}", false)
        },
        strs()),
        pv("qwen-token-plan-individual", "通义 Token Plan（个人版）", "", "★ 个人版套餐 Key，与按量计费 / 企业版都不通用", "",
        new Endpoint[] {
            ep("新加坡", "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", true)
        },
        strs("qwen3-max", "qwen-plus")),
    };

    // ---------------- 生成的字面量（9 条思考档位服务） ----------------

    private static final Service[] SERVICES = new Service[] {
        sv("deepseek", "DeepSeek 官方", strs("api.deepseek.com"), strs("off", "low", "high", "max")),
        sv("zhipu", "智谱 GLM", strs("open.bigmodel.cn", "api.z.ai"), strs("off", "low", "high", "max")),
        sv("qwen", "通义千问（百炼）", strs("dashscope.aliyuncs.com"), strs("off", "low", "medium", "max")),
        sv("openai", "OpenAI 官方", strs("api.openai.com"), strs("off", "low", "medium", "high", "max")),
        sv("siliconflow", "硅基流动", strs("api.siliconflow.cn"), strs("off", "high", "max")),
        sv("commandcode", "Command Code（聚合网关 / Token Plan）", strs("api.commandcode.ai"), strs("low", "medium", "high", "max")),
        sv("opendesign", "OpenDesign（amr-link 网关）", strs("amr-link.open-design.ai"), strs("off", "low", "high", "max")),
        sv("opencode", "OpenCode（Go 订阅）", strs("opencode.ai", "api.opencode.ai"), strs("low", "medium", "high", "max")),
        sv("custom", "自定义 / 自建（OpenAI 兼容）", strs(), strs()),
    };

    // ---------------- 查询 ----------------

    /** 全部渠道预置（46 条）；返回副本，调用方改不动静态表。 */
    public static Provider[] providers() {
        return PROVIDERS.clone();
    }

    /** 按 id 取渠道预置，取不到返回 {@code null}。id 忽略大小写与首尾空白。 */
    public static Provider providerById(String id) {
        if (id == null) {
            return null;
        }
        String key = id.trim().toLowerCase(java.util.Locale.ROOT);
        if (key.isEmpty()) {
            return null;
        }
        for (Provider p : PROVIDERS) {
            if (p.id.equalsIgnoreCase(key)) {
                return p;
            }
        }
        return null;
    }

    /** 全部思考档位服务（9 条）。 */
    public static Service[] services() {
        return SERVICES.clone();
    }

    /**
     * 按 baseUrl 的 host 匹配档位服务；表外渠道（匹配不到）返回 {@code null}。
     *
     * @param baseUrl 形如 {@code https://api.deepseek.com/v1}（可带端口、路径、userinfo）
     */
    public static Service serviceForBaseUrl(String baseUrl) {
        String host = hostOf(baseUrl);
        if (host.isEmpty()) {
            return null;
        }
        for (Service s : SERVICES) {
            for (String h : s.hosts) {
                if (h != null && h.equalsIgnoreCase(host)) {
                    return s;
                }
            }
        }
        return null;
    }

    /**
     * 该 baseUrl 对应的可用档位；表外渠道返回<b>空数组</b>（不是 null）。
     *
     * <p>注意：返回值可能不含 {@code off}（opencode / commandcode 就是这样），别自行补。
     */
    public static String[] levelsFor(String baseUrl) {
        Service s = serviceForBaseUrl(baseUrl);
        if (s == null || s.uiLevels.length == 0) {
            return new String[0];
        }
        return s.uiLevels.clone();
    }

    /** 取 URL 的主机名：去协议 / userinfo / 端口 / 路径，转小写；非法输入返回空串。 */
    private static String hostOf(String url) {
        if (url == null) {
            return "";
        }
        String s = url.trim();
        if (s.isEmpty()) {
            return "";
        }
        int scheme = s.indexOf("://");
        if (scheme >= 0) {
            s = s.substring(scheme + 3);
        }
        int at = s.indexOf('@');
        if (at >= 0) {
            s = s.substring(at + 1);
        }
        int cut = s.length();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '/' || c == '?' || c == '#') {
                cut = i;
                break;
            }
        }
        s = s.substring(0, cut);
        if (s.isEmpty()) {
            return "";
        }
        if (s.charAt(0) == '[') {
            // IPv6 字面量：[::1]:8080 -> [::1]
            int close = s.indexOf(']');
            if (close < 0) {
                return "";
            }
            s = s.substring(0, close + 1);
        } else {
            int colon = s.indexOf(':');
            if (colon >= 0) {
                s = s.substring(0, colon);
            }
        }
        return s.isEmpty() ? "" : s.toLowerCase(java.util.Locale.ROOT);
    }

    // ---------------- 生成器用的构造辅助（运行时无副作用） ----------------

    private static Endpoint ep(String label, String baseUrl, boolean recommended) {
        return new Endpoint(label, baseUrl, recommended);
    }

    private static Provider pv(String id, String label, String docUrl, String note, String sessionHeader,
                               Endpoint[] endpoints, String[] commonModels) {
        return new Provider(id, label, docUrl, note, sessionHeader, endpoints, commonModels);
    }

    private static Service sv(String id, String label, String[] hosts, String[] uiLevels) {
        return new Service(id, label, hosts, uiLevels);
    }

    private static String[] strs(String... values) {
        return values == null || values.length == 0 ? new String[0] : values;
    }
}
