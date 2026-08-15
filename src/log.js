/**
 * dsh-notify-bell — 日志后端。
 *
 * 职责：把通知文本写到 stdout（前台终端可见，重定向时落盘），
 * 并按 maxLength 截断长文本（超出以 … 结尾）。
 */
export function createLogBackend(options = {}) {
	const write = options.write ?? ((chunk) => process.stdout.write(chunk));
	const maxLength = options.maxLength ?? 120;

	/** 截断文本到 maxLength 字符，超出以 … 结尾。 */
	const truncate = (text) => {
		const str = String(text);
		return str.length > maxLength ? str.slice(0, maxLength) + '…' : str;
	};

	/** 输出一行日志（自带换行）。 */
	const line = (text) => write(String(text) + '\n');

	return { truncate, line };
}
