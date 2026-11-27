import { createMemo } from "../adapters/memos.js";
import { editMessage, sendToChannel } from "../adapters/telegram.js";
import { formatPublicError } from "../lib/errors.js";
import { jsonLog } from "../lib/logger.js";
import { composeContent, formatSelectedTags } from "../lib/tags.js";
import { finishJob, loadJob, setChannelMediaMessageId, updateTarget } from "../repositories/store.js";

export async function processQueueBatch(batch, env) {
  for (const message of batch.messages) {
    try {
      const retry = await processJob(env, message.body.jobId);
      if (retry && message.attempts < 3) message.retry({ delaySeconds: message.attempts === 1 ? 30 : 120 });
      else message.ack();
    } catch (error) {
      jsonLog("error", "queue_job_crashed", { error, jobId: message.body?.jobId });
      if (message.attempts < 3) message.retry({ delaySeconds: 60 }); else message.ack();
    }
  }
}

export async function processJob(env, jobId) {
  let job = await loadJob(env, jobId);
  if (!job || ["success", "partial", "failed"].includes(job.status)) return false;
  await finishJob(env, jobId, "processing");
  const finalContent = composeContent(job.content, job.selectedTags);
  let retry = false;

  if (job.memos_status !== "success") {
    try {
      await createMemo(env, finalContent, job.visibility, job.fileIds);
      await updateTarget(env, jobId, "memos", "success");
    } catch (error) {
      retry ||= Boolean(error.retryable);
      await updateTarget(env, jobId, "memos", error.retryable ? "retrying" : "failed", formatPublicError(error));
      jsonLog("error", "sync_target_failed", { jobId, target: "memos", status: error.status, error });
    }
  }

  if (job.channel_status !== "success") {
    const channelId = job.visibility === "PUBLIC" ? env.CHANNEL_ID_PUBLIC : env.CHANNEL_ID_PRIVATE;
    try {
      await sendToChannel(env, channelId, finalContent, job.fileIds, {
        channelMediaMessageId: job.channel_media_message_id,
        onMediaSent: (messageId) => setChannelMediaMessageId(env, jobId, messageId)
      });
      await updateTarget(env, jobId, "channel", "success");
    } catch (error) {
      retry ||= Boolean(error.retryable);
      await updateTarget(env, jobId, "channel", error.retryable ? "retrying" : "failed", formatPublicError(error));
      jsonLog("error", "sync_target_failed", { jobId, target: "channel", status: error.status, error });
    }
  }

  job = await loadJob(env, jobId);
  const done = [job.memos_status, job.channel_status].every((status) => ["success", "failed"].includes(status));
  const status = !done ? "retrying" : job.memos_status === "success" && job.channel_status === "success" ? "success" :
    job.memos_status === "failed" && job.channel_status === "failed" ? "failed" : "partial";
  await finishJob(env, jobId, status);
  await updateResult(env, job);
  return retry && !done;
}

async function updateResult(env, job) {
  const icon = job.memos_status === "success" && job.channel_status === "success" ? "✅" : "⚠️";
  const line = (label, status, error) => `${label}：${status === "success" ? "成功" : status === "retrying" ? "等待重试" : `失败（${error || "未知错误"}）`}`;
  const tagsText = job.selectedTags.length ? formatSelectedTags(job.selectedTags) : "无";
  const text = `${icon} 同步结果\n\n${line("Memos", job.memos_status, job.memos_error)}\n${line("TG频道", job.channel_status, job.channel_error)}\n标签：${tagsText}\n任务：${job.job_id.slice(0, 8)}`;
  try { await editMessage(env, job.result_chat_id, job.result_message_id, text); }
  catch (error) { jsonLog("warn", "result_message_failed", { jobId: job.job_id, error }); }
}
