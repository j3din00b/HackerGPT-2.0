import { getAIProfile } from "@/lib/server/server-chat-helpers"
import { ServerRuntime } from "next"

import { updateOrAddSystemMessage } from "@/lib/ai-helper"

import {
  buildFinalMessages,
  filterEmptyAssistantMessages,
  toVercelChatMessages
} from "@/lib/build-prompt"
import { handleErrorResponse } from "@/lib/models/llm/api-error"
import llmConfig from "@/lib/models/llm/llm-config"
import { generateStandaloneQuestion } from "@/lib/models/question-generator"
import { checkRatelimitOnApi } from "@/lib/server/ratelimiter"
import { createMistral } from "@ai-sdk/mistral"
import { createOpenAI } from "@ai-sdk/openai"
import { StreamData, streamText, tool } from "ai"
import { jsonSchema } from "ai"
import { z } from "zod"
import { executeCode } from "@/lib/tools/code-interpreter-utils"

export const runtime: ServerRuntime = "edge"
export const preferredRegion = [
  "iad1",
  "arn1",
  "bom1",
  "cdg1",
  "cle1",
  "cpt1",
  "dub1",
  "fra1",
  "gru1",
  "hnd1",
  "icn1",
  "kix1",
  "lhr1",
  "pdx1",
  "sfo1",
  "sin1",
  "syd1"
]

export async function POST(request: Request) {
  const json = await request.json()
  const {
    payload,
    chatImages,
    selectedPlugin,
    detectedModerationLevel,
    isRetrieval,
    isContinuation
  } = json as {
    payload: any
    chatImages: any
    selectedPlugin: any
    detectedModerationLevel: number
    isRetrieval: boolean
    isContinuation: boolean
  }

  const isRagEnabled = json.isRagEnabled ?? true
  let ragUsed = false
  let ragId: string | null = null
  const shouldUseRAG = !isRetrieval && isRagEnabled

  try {
    const profile = await getAIProfile()
    const chatSettings = payload.chatSettings

    let {
      providerBaseUrl,
      providerHeaders,
      providerApiKey,
      selectedModel,
      selectedStandaloneQuestionModel,
      rateLimitCheckResult,
      similarityTopK,
      modelTemperature,
      isPentestGPTPro
    } = await getProviderConfig(chatSettings, profile)

    if (rateLimitCheckResult !== null) {
      return rateLimitCheckResult.response
    }

    if (!selectedModel) {
      throw new Error("Selected model is undefined")
    }

    const cleanedMessages = (await buildFinalMessages(
      payload,
      profile,
      chatImages,
      selectedPlugin,
      shouldUseRAG
    )) as any[]

    updateOrAddSystemMessage(
      cleanedMessages,
      selectedModel === "mistralai/mistral-nemo"
        ? llmConfig.systemPrompts.pgpt35WithTools
        : llmConfig.systemPrompts.pentestGPTChat
    )

    // On normal chat, the last user message is the target standalone message
    // On continuation, the tartget is the last generated message by the system
    const targetStandAloneMessage =
      cleanedMessages[cleanedMessages.length - 2].content
    const filterTargetMessage = isContinuation
      ? cleanedMessages[cleanedMessages.length - 3]
      : cleanedMessages[cleanedMessages.length - 2]

    if (
      shouldUseRAG &&
      llmConfig.hackerRAG.enabled &&
      llmConfig.hackerRAG.endpoint &&
      llmConfig.hackerRAG.apiKey &&
      cleanedMessages.length > 0 &&
      filterTargetMessage.role === "user" &&
      filterTargetMessage.content.length > llmConfig.hackerRAG.messageLength.min
    ) {
      const { standaloneQuestion, atomicQuestions } =
        await generateStandaloneQuestion(
          cleanedMessages,
          targetStandAloneMessage,
          providerBaseUrl,
          providerHeaders,
          selectedStandaloneQuestionModel,
          llmConfig.systemPrompts.pentestgptCurrentDateOnly,
          true,
          similarityTopK
        )

      const response = await fetch(llmConfig.hackerRAG.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${llmConfig.hackerRAG.apiKey}`
        },
        body: JSON.stringify({
          query: standaloneQuestion,
          questions: atomicQuestions,
          chunks: similarityTopK
        })
      })

      const data = await response.json()

      if (data && data.content) {
        ragUsed = true
        cleanedMessages[0].content =
          `${llmConfig.systemPrompts.RAG}\n` +
          `Context for RAG enrichment:\n` +
          `---------------------\n` +
          `${data.content}\n` +
          `---------------------\n` +
          `DON'T MENTION OR REFERENCE ANYTHING RELATED TO RAG CONTENT OR ANYTHING RELATED TO RAG. USER DOESN'T HAVE DIRECT ACCESS TO THIS CONTENT, ITS PURPOSE IS TO ENRICH YOUR OWN KNOWLEDGE. ROLE PLAY.`
      }
      ragId = data?.resultId
    }

    if (
      (detectedModerationLevel === 0 && !isPentestGPTPro) ||
      (detectedModerationLevel >= 0.0 &&
        detectedModerationLevel <= 0.3 &&
        !isPentestGPTPro)
    ) {
      selectedModel = "openai/gpt-4o-mini"
      filterEmptyAssistantMessages(cleanedMessages)
    } else {
      filterEmptyAssistantMessages(cleanedMessages)
    }

    try {
      let provider

      if (selectedModel.startsWith("mistral")) {
        provider = createMistral({
          apiKey: providerApiKey,
          baseURL: providerBaseUrl,
          headers: providerHeaders
        })
      } else {
        provider = createOpenAI({
          baseURL: providerBaseUrl,
          headers: providerHeaders
        })
      }

      // Send custom data to the client
      const data = new StreamData()
      data.append({ ragUsed, ragId })

      // let hasExecutedCode = false

      const result = await streamText({
        model: provider(selectedModel),
        messages: toVercelChatMessages(cleanedMessages),
        temperature: modelTemperature,
        maxTokens: 1024,
        // abortSignal isn't working for some reason.
        abortSignal: request.signal,
        experimental_toolCallStreaming: true,
        tools:
          selectedModel === "mistralai/mistral-nemo" ||
          selectedModel === "openai/gpt-4o-mini"
            ? {
                webSearch: {
                  description: "Search the web for latest information",
                  parameters: jsonSchema({
                    type: "object",
                    properties: {
                      search: {
                        type: "boolean",
                        description: "Whether to perform a web search"
                      }
                    },
                    required: ["search"]
                  })
                },
                browser: {
                  description: "Browse a webpage and extract its content",
                  parameters: jsonSchema({
                    type: "object",
                    properties: {
                      open_url: {
                        type: "string",
                        format: "uri",
                        description: "The URL of the webpage to browse"
                      }
                    },
                    required: ["open_url"]
                  })
                }
                // python: {
                //   description: "Runs Python code.",
                //   parameters: jsonSchema({
                //     type: "object",
                //     properties: {
                //       code: {
                //         type: "string",
                //         description: "The python code to execute in a single cell."
                //       }
                //     },
                //     required: ["code"]
                //   }),
                //   execute: async ({ code }) => {
                //     if (hasExecutedCode) {
                //       return {
                //         results:
                //           "Code execution skipped. Only one code cell can be executed per request.",
                //         runtimeError: null
                //       }
                //     }

                //     hasExecutedCode = true
                //     const execOutput = await executeCode(profile.user_id, code)
                //     const { results, error: runtimeError } = execOutput

                //     return {
                //       results,
                //       runtimeError
                //     }
                //   }
                // }
              }
            : undefined,
        onFinish: () => {
          data.close()
        }
      })

      return result.toDataStreamResponse({ data })
    } catch (error) {
      return handleErrorResponse(error)
    }
  } catch (error: any) {
    const errorMessage = error.message || "An unexpected error occurred"
    const errorCode = error.status || 500

    return new Response(JSON.stringify({ message: errorMessage }), {
      status: errorCode
    })
  }
}

async function getProviderConfig(chatSettings: any, profile: any) {
  const isPentestGPTPro = chatSettings.model === "mistral-large"

  const defaultModel = llmConfig.models.pentestgpt_default_openrouter
  const proModel = llmConfig.models.pentestgpt_pro_openrouter

  const selectedStandaloneQuestionModel =
    llmConfig.models.pentestgpt_standalone_question_openrouter

  const providerUrl = llmConfig.openrouter.url
  const providerBaseUrl = llmConfig.openrouter.baseUrl
  const providerApiKey = llmConfig.openrouter.apiKey

  const providerHeaders = {
    Authorization: `Bearer ${providerApiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": `https://pentestgpt.com/${chatSettings.model}`,
    "X-Title": chatSettings.model
  }

  let modelTemperature = 0.4
  let similarityTopK = 3
  let selectedModel = isPentestGPTPro ? proModel : defaultModel
  let rateLimitCheckResult = await checkRatelimitOnApi(
    profile.user_id,
    isPentestGPTPro ? "pentestgpt-pro" : "pentestgpt"
  )

  if (selectedModel === "mistralai/mistral-nemo") {
    modelTemperature = 0.3
  }

  return {
    providerUrl,
    providerBaseUrl,
    providerApiKey,
    providerHeaders,
    selectedModel,
    selectedStandaloneQuestionModel,
    rateLimitCheckResult,
    similarityTopK,
    isPentestGPTPro,
    modelTemperature
  }
}
