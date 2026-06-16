import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

type ChatRole = "user" | "assistant";

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
};

type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
};

const KEY_STORAGE = "openrouter-api-key";
const MODEL_STORAGE = "openrouter-model";
const CHATS_STORAGE = "openrouter-chat-history";
const ACTIVE_CHAT_STORAGE = "openrouter-active-chat";

const defaultConversation = (): Conversation => {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
};

const formatDate = (isoDate: string) =>
  new Date(isoDate).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const extractAssistantText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          return typeof part.text === "string" ? part.text : "";
        }
        return "";
      })
      .join("\n")
      .trim();
  }
  return "";
};

export default function App() {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("openai/gpt-4o-mini");
  const [prompt, setPrompt] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const savedKey = localStorage.getItem(KEY_STORAGE);
    const savedModel = localStorage.getItem(MODEL_STORAGE);
    const savedChats = localStorage.getItem(CHATS_STORAGE);
    const savedActiveChat = localStorage.getItem(ACTIVE_CHAT_STORAGE);

    if (savedKey) setApiKey(savedKey);
    if (savedModel) setModel(savedModel);

    if (savedChats) {
      try {
        const parsedChats = JSON.parse(savedChats) as Conversation[];
        if (Array.isArray(parsedChats) && parsedChats.length > 0) {
          const validChats = parsedChats.filter(
            (chat) => chat && Array.isArray(chat.messages) && typeof chat.id === "string"
          );

          if (validChats.length > 0) {
            setConversations(validChats);
            const activeExists = validChats.some((chat) => chat.id === savedActiveChat);
            setActiveConversationId(activeExists ? savedActiveChat || validChats[0].id : validChats[0].id);
            setHydrated(true);
            return;
          }
        }
      } catch {
        // Ignore malformed storage and start from a clean state.
      }
    }

    const firstChat = defaultConversation();
    setConversations([firstChat]);
    setActiveConversationId(firstChat.id);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [activeConversationId, conversations, loading]);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(KEY_STORAGE, apiKey);
  }, [apiKey, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(MODEL_STORAGE, model);
  }, [model, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(CHATS_STORAGE, JSON.stringify(conversations));
  }, [conversations, hydrated]);

  useEffect(() => {
    if (!hydrated || !activeConversationId) return;
    localStorage.setItem(ACTIVE_CHAT_STORAGE, activeConversationId);
  }, [activeConversationId, hydrated]);

  const apiReady = useMemo(() => apiKey.trim().length > 0, [apiKey]);
  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId),
    [conversations, activeConversationId]
  );
  const messages = activeConversation?.messages ?? [];

  const createNewChat = () => {
    const nextChat = defaultConversation();
    setConversations((prev) => [nextChat, ...prev]);
    setActiveConversationId(nextChat.id);
    setPrompt("");
    setError("");
  };

  const upsertConversation = (conversationId: string, updater: (conversation: Conversation) => Conversation) => {
    setConversations((prev) => {
      const exists = prev.some((chat) => chat.id === conversationId);
      const fallbackConversation: Conversation = {
        ...defaultConversation(),
        id: conversationId,
      };
      const updated = exists
        ? prev.map((chat) => (chat.id === conversationId ? updater(chat) : chat))
        : [updater(fallbackConversation), ...prev];

      return [...updated].sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));
    });
  };

  const sendPrompt = async () => {
    if (!apiReady || !prompt.trim() || loading) return;

    const trimmedPrompt = prompt.trim();
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmedPrompt,
    };

    let targetConversationId = activeConversationId;
    let baseMessages = messages;

    if (!targetConversationId) {
      const freshConversation = defaultConversation();
      targetConversationId = freshConversation.id;
      setConversations((prev) => [freshConversation, ...prev]);
      setActiveConversationId(targetConversationId);
      baseMessages = [];
    }

    const nextMessages = [...baseMessages, userMessage];
    const now = new Date().toISOString();

    setPrompt("");
    setError("");
    setLoading(true);

    upsertConversation(targetConversationId, (conversation) => ({
      ...conversation,
      title: conversation.messages.length === 0 ? trimmedPrompt.slice(0, 42) : conversation.title,
      updatedAt: now,
      messages: [...conversation.messages, userMessage],
    }));

    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey.trim()}`,
          "X-Title": "OpenRouter AI Web App",
        },
        body: JSON.stringify({
          model: model.trim(),
          messages: nextMessages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        const serverMessage = data?.error?.message || "OpenRouter request failed.";
        throw new Error(serverMessage);
      }

      const assistantText = extractAssistantText(data?.choices?.[0]?.message?.content);
      if (!assistantText) {
        throw new Error("No response text returned by model.");
      }

      upsertConversation(targetConversationId, (conversation) => ({
        ...conversation,
        updatedAt: new Date().toISOString(),
        messages: [
          ...conversation.messages,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: assistantText,
          },
        ],
      }));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unexpected request error.");
    } finally {
      setLoading(false);
    }
  };

  const handlePromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendPrompt();
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto grid min-h-screen w-full max-w-6xl gap-6 px-4 py-8 sm:px-8 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="order-2 lg:order-1">
          <motion.div
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.45 }}
            className="space-y-3"
          >
            <button
              type="button"
              onClick={createNewChat}
              className="h-10 w-full rounded-md bg-cyan-400 text-sm font-semibold text-slate-900 transition hover:bg-cyan-300"
            >
              New Chat
            </button>

            <div className="max-h-[70vh] space-y-1 overflow-y-auto pr-1">
              {conversations.map((conversation) => (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => {
                    setActiveConversationId(conversation.id);
                    setError("");
                  }}
                  className={`w-full rounded-md px-3 py-2 text-left text-sm transition ${
                    conversation.id === activeConversationId
                      ? "bg-slate-800 text-slate-100"
                      : "text-slate-400 hover:bg-slate-900 hover:text-slate-200"
                  }`}
                >
                  <p className="truncate font-medium">{conversation.title || "New chat"}</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {conversation.messages.length} messages | {formatDate(conversation.updatedAt)}
                  </p>
                </button>
              ))}
            </div>
          </motion.div>
        </aside>

        <main className="order-1 flex min-h-screen flex-col lg:order-2">
        <motion.header
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45 }}
          className="mb-6"
        >
          <p className="text-xs uppercase tracking-[0.24em] text-cyan-300">OpenRouter AI</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">OpenRouter AI Chat</h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-300 sm:text-base">
            Paste your OpenRouter API key, choose a model, and start chatting instantly.
          </p>
        </motion.header>

        <section className="mb-5 grid gap-3 sm:grid-cols-[1fr_220px]">
          <label className="flex flex-col gap-2">
            <span className="text-sm text-slate-300">OpenRouter API Key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="sk-or-v1-..."
              className="h-11 rounded-md border border-slate-700 bg-slate-900/70 px-3 text-sm outline-none ring-cyan-400 transition focus:ring"
            />
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm text-slate-300">Model</span>
            <input
              type="text"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="openai/gpt-4o-mini"
              className="h-11 rounded-md border border-slate-700 bg-slate-900/70 px-3 text-sm outline-none ring-cyan-400 transition focus:ring"
            />
          </label>
        </section>

        <div
          ref={listRef}
          className="flex-1 space-y-3 overflow-y-auto rounded-lg border border-slate-800 bg-slate-900/40 p-3"
        >
          {messages.length === 0 && (
            <p className="p-2 text-sm text-slate-400">
              Start by asking anything. Your key stays in your browser local storage.
            </p>
          )}

          <AnimatePresence initial={false}>
            {messages.map((message) => (
              <motion.div
                key={message.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                  message.role === "user"
                    ? "ml-auto bg-cyan-500/20 text-cyan-100"
                    : "bg-slate-800 text-slate-100"
                }`}
              >
                {message.content}
              </motion.div>
            ))}
          </AnimatePresence>

          {loading && (
            <motion.p
              initial={{ opacity: 0.35 }}
              animate={{ opacity: 1 }}
              transition={{ repeat: Infinity, repeatType: "reverse", duration: 0.8 }}
              className="text-sm text-slate-400"
            >
              Thinking...
            </motion.p>
          )}
        </div>

        <form
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void sendPrompt();
          }}
          className="mt-4 space-y-3"
        >
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={handlePromptKeyDown}
            rows={4}
            placeholder={apiReady ? "Ask something..." : "Add your API key first"}
            className="w-full rounded-lg border border-slate-700 bg-slate-900/70 p-3 text-sm outline-none ring-cyan-400 transition focus:ring"
          />

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-slate-400">Enter sends. Shift+Enter adds a new line.</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  if (!activeConversationId) return;

                  upsertConversation(activeConversationId, (conversation) => ({
                    ...conversation,
                    title: "New chat",
                    messages: [],
                    updatedAt: new Date().toISOString(),
                  }));

                  setError("");
                }}
                className="h-10 rounded-md border border-slate-700 px-4 text-sm text-slate-200 transition hover:border-slate-500"
              >
                Clear Chat
              </button>
              <button
                type="submit"
                disabled={!apiReady || !prompt.trim() || loading}
                className="h-10 rounded-md bg-cyan-400 px-4 text-sm font-semibold text-slate-900 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-300"
              >
                Send
              </button>
            </div>
          </div>
        </form>

        {error && <p className="mt-3 text-sm text-rose-300">Error: {error}</p>}

        <p className="mt-4 text-xs text-slate-500">API key, model, and chat history are auto-saved in your browser.</p>
        </main>
      </div>
    </div>
  );
}
