/**
 * @author Kuitos
 * @homepage https://github.com/kuitos/
 * @since 2018-08-15 11:37
 */

import processTpl, { genLinkReplaceSymbol, genScriptReplaceSymbol } from './process-tpl';
import {
	defaultGetPublicPath,
	evalCode,
	getGlobalProp,
	getInlineCode,
	noteGlobalProps,
	readResAsString,
	requestIdleCallback,
} from './utils';

const styleCache = {};
const scriptCache = {};
const embedHTMLCache = {};

if (!window.fetch) {
	throw new Error('[import-html-entry] Here is no "fetch" on the window env, you need to polyfill it');
}
const defaultFetch = window.fetch.bind(window);

/**
 * 默认是直接返回 tpl
 * @param {*} tpl 
 * @returns 
 */
function defaultGetTemplate(tpl) {
	return tpl;
}

/**
 * convert external css link to inline style for performance optimization
 * @param template 类似于这种的存在，主要是里面的html <!--  link styles replaced by import-html-entry -->html<!--   script scripts replaced by import-html-entry -->
 * @param styles styles 数组
 * @param opts fetch 默认是 window.fetch 请求
 * @return {string} embedHTML 将 css 放在 html 前面 js放在 html 后面
 */
function getEmbedHTML(template, styles, opts = {}) {
	const { fetch = defaultFetch } = opts;
	let embedHTML = template;

	return getExternalStyleSheets(styles, fetch)
		.then(styleSheets => {
			embedHTML = styles.reduce((html, styleSrc, i) => {
				// 在这里将对应的 style 返回回来
				html = html.replace(genLinkReplaceSymbol(styleSrc), isInlineCode(styleSrc) ? `${styleSrc}` : `<style>/* ${styleSrc} */${styleSheets[i]}</style>`);
				return html;
			}, embedHTML);
			return embedHTML;
		});
}

/** 判断是否以 ‘<’ 字符串开头 */
const isInlineCode = code => code.startsWith('<');

/**
 * 生成一个代码字符串，类似于模块化一样将方法包裹一层。
 * @param {*} scriptSrc 
 * @param {*} scriptText 
 * @param {*} opts 
 * @returns 
 */
function getExecutableScript(scriptSrc, scriptText, opts = {}) {
	const { proxy, strictGlobal, scopedGlobalVariables = [] } = opts;

	const sourceUrl = isInlineCode(scriptSrc) ? '' : `//# sourceURL=${scriptSrc}\n`;

	// 将 scopedGlobalVariables 拼接成变量声明，用于缓存全局变量，避免每次使用时都走一遍代理
	const scopedGlobalVariableDefinition = scopedGlobalVariables.length ? `const {${scopedGlobalVariables.join(',')}}=this;` : '';

	// 通过这种方式获取全局 window ，因为 script 也是在全局作用域下运行的，所以我们通过 window.proxy 绑定时也必须确保绑定到全局 window 上
	// 否则在嵌套场景下， window.proxy 设置的是内层应用的 window，而代码其实是在全局作用域运行的，会导致闭包里的 window.proxy 取的是最外层的微应用的 proxy
	const globalWindow = (0, eval)('window');
	globalWindow.proxy = proxy;
	// TODO 通过 strictGlobal 方式切换 with 闭包，待 with 方式坑趟平后再合并
	return strictGlobal
		? (
			scopedGlobalVariableDefinition
				? `;(function(){with(this){${scopedGlobalVariableDefinition}${scriptText}\n${sourceUrl}}}).bind(window.proxy)();`
				: `;(function(window, self, globalThis){with(window){;${scriptText}\n${sourceUrl}}}).bind(window.proxy)(window.proxy, window.proxy, window.proxy);`
		)
		: `;(function(window, self, globalThis){;${scriptText}\n${sourceUrl}}).bind(window.proxy)(window.proxy, window.proxy, window.proxy);`;
}

// for prefetch
/**
 * 主要是将 styles 中的内容返回
 * @param {Array<string>} styles styles数组
 * @param {fetch} fetch 请求方法
 * @returns {Array<Promise<string>>} styles text部分
 */
export function getExternalStyleSheets(styles, fetch = defaultFetch) {
	return Promise.all(styles.map(styleLink => {
			if (isInlineCode(styleLink)) {
				// if it is inline style
				// 如果是 <style>xxxx</style>
				return getInlineCode(styleLink);
			} else {
				// external styles
				// 判断是否存在于缓存，然后将 css 内容返回同时存储缓存
				return styleCache[styleLink] ||
					(styleCache[styleLink] = fetch(styleLink).then(response => response.text()));
			}
		},
	));
}

// for prefetch
/**
 * 获取 scripts 信息 返回的是 text()
 * @param {*} scripts 
 * @param {*} fetch 
 * @param {*} errorCallback 
 * @returns 
 */
export function getExternalScripts(scripts, fetch = defaultFetch, errorCallback = () => {
}) {

	/**
	 * 请求 script 数据
	 * 使用了 requestIdleCallback api
	 * @param {*} scriptUrl 
	 * @param {*} opts 
	 * @returns 
	 */
	const fetchScript = (scriptUrl, opts) => scriptCache[scriptUrl] ||
		(scriptCache[scriptUrl] = fetch(scriptUrl, opts).then(response => {
			// usually browser treats 4xx and 5xx response of script loading as an error and will fire a script error event
			// 通常浏览器将加载脚本的4xx和5xx响应视为错误，并触发脚本错误事件
			// https://stackoverflow.com/questions/5625420/what-http-headers-responses-trigger-the-onerror-handler-on-a-script-tag/5625603
			return response.text();
		}).catch(e => {
			errorCallback();
			throw e;
		}));

	return Promise.all(scripts.map(script => {

			if (typeof script === 'string') {
				if (isInlineCode(script)) {
					// if it is inline script
					return getInlineCode(script);
				} else {
					// external script
					return fetchScript(script);
				}
			} else {
				// use idle time to load async script
				const { src, async, crossOrigin } = script;
				const fetchOpts = crossOrigin ? { credentials: 'include' } : {};

				if (async) {
					return {
						src,
						async: true,
						content: new Promise((resolve, reject) => requestIdleCallback(() => fetchScript(src, fetchOpts).then(resolve, reject))),
					};
				}

				return fetchScript(src, fetchOpts);
			}
		},
	));
}

function throwNonBlockingError(error, msg) {
	setTimeout(() => {
		console.error(msg);
		throw error;
	});
}

const supportsUserTiming =
	typeof performance !== 'undefined' &&
	typeof performance.mark === 'function' &&
	typeof performance.clearMarks === 'function' &&
	typeof performance.measure === 'function' &&
	typeof performance.clearMeasures === 'function';

/**
 * FIXME要与浏览器行为一致，我们应该只提供回调方式来调用成功和错误事件
 * 类似于执行 script 方法
 * @param entry
 * @param scripts
 * @param proxy
 * @param opts
 * @returns {Promise<unknown>}
 */
export function execScripts(entry, scripts, proxy = window, opts = {}) {
	const {
		fetch = defaultFetch, strictGlobal = false, success, error = () => {
		}, beforeExec = () => {
		}, afterExec = () => {
		},
		scopedGlobalVariables = [],
	} = opts;

	return getExternalScripts(scripts, fetch, error)
		.then(scriptsText => {

			/**
			 * 使用 eval 进行处理 执行
			 * @param {*} scriptSrc 
			 * @param {*} inlineScript 
			 */
			const geval = (scriptSrc, inlineScript) => {
				const rawCode = beforeExec(inlineScript, scriptSrc) || inlineScript;
				const code = getExecutableScript(scriptSrc, rawCode, { proxy, strictGlobal, scopedGlobalVariables });

				evalCode(scriptSrc, code);

				afterExec(inlineScript, scriptSrc);
			};

			/**
			 * 执行 geval 方法
			 * @param {*} scriptSrc 
			 * @param {*} inlineScript 
			 * @param {*} resolve 
			 */
			function exec(scriptSrc, inlineScript, resolve) {

				const markName = `Evaluating script ${scriptSrc}`;
				const measureName = `Evaluating Time Consuming: ${scriptSrc}`;

				if (process.env.NODE_ENV === 'development' && supportsUserTiming) {
					performance.mark(markName);
				}

				if (scriptSrc === entry) {
					noteGlobalProps(strictGlobal ? proxy : window);

					try {
						geval(scriptSrc, inlineScript);
						const exports = proxy[getGlobalProp(strictGlobal ? proxy : window)] || {};
						resolve(exports);
					} catch (e) {
						// entry error must be thrown to make the promise settled
						console.error(`[import-html-entry]: error occurs while executing entry script ${scriptSrc}`);
						throw e;
					}
				} else {
					if (typeof inlineScript === 'string') {
						try {
							if (scriptSrc?.src) {
								geval(scriptSrc.src, inlineScript);
							} else {
								geval(scriptSrc, inlineScript);
							}
						} catch (e) {
							// consistent with browser behavior, any independent script evaluation error should not block the others
							throwNonBlockingError(e, `[import-html-entry]: error occurs while executing normal script ${scriptSrc}`);
						}
					} else {
						// external script marked with async
						inlineScript.async && inlineScript?.content
							.then(downloadedScriptText => geval(inlineScript.src, downloadedScriptText))
							.catch(e => {
								throwNonBlockingError(e, `[import-html-entry]: error occurs while executing async script ${inlineScript.src}`);
							});
					}
				}

				if (process.env.NODE_ENV === 'development' && supportsUserTiming) {
					performance.measure(measureName, markName);
					performance.clearMarks(markName);
					performance.clearMeasures(measureName);
				}
			}

			function schedule(i, resolvePromise) {

				if (i < scripts.length) {
					const scriptSrc = scripts[i];
					const inlineScript = scriptsText[i];

					exec(scriptSrc, inlineScript, resolvePromise);
					// resolve the promise while the last script executed and entry not provided
					if (!entry && i === scripts.length - 1) {
						resolvePromise();
					} else {
						schedule(i + 1, resolvePromise);
					}
				}
			}

			return new Promise(resolve => schedule(0, success || resolve));
		});
}

export default function importHTML(url, opts = {}) {
	let fetch = defaultFetch;
	let autoDecodeResponse = false;
	let getPublicPath = defaultGetPublicPath;
	let getTemplate = defaultGetTemplate;
	const { postProcessTemplate } = opts;

	// compatible with the legacy importHTML api
	if (typeof opts === 'function') {
		fetch = opts;
	} else {
		// fetch option is availble
		if (opts.fetch) {
			// fetch is a funciton
			if (typeof opts.fetch === 'function') {
				fetch = opts.fetch;
			} else { // configuration
				fetch = opts.fetch.fn || defaultFetch;
				autoDecodeResponse = !!opts.fetch.autoDecodeResponse;
			}
		}
		getPublicPath = opts.getPublicPath || opts.getDomain || defaultGetPublicPath;
		getTemplate = opts.getTemplate || defaultGetTemplate;
	}

	return embedHTMLCache[url] || (embedHTMLCache[url] = fetch(url)
		.then(response => readResAsString(response, autoDecodeResponse))
		.then(html => {

			const assetPublicPath = getPublicPath(url);
			const { template, scripts, entry, styles } = processTpl(getTemplate(html), assetPublicPath, postProcessTemplate);

			return getEmbedHTML(template, styles, { fetch }).then(embedHTML => ({
				template: embedHTML,
				assetPublicPath,
				getExternalScripts: () => getExternalScripts(scripts, fetch),
				getExternalStyleSheets: () => getExternalStyleSheets(styles, fetch),
				execScripts: (proxy, strictGlobal, opts = {}) => {
					if (!scripts.length) {
						return Promise.resolve();
					}
					return execScripts(entry, scripts, proxy, {
						fetch,
						strictGlobal,
						...opts,
					});
				},
			}));
		}));
}

/**
 * @param {string | { scripts?: string[]; styles?: string[]; html?: string }} entry 应用入口
 * @param {*} opts 
 * @returns 
 */
export function importEntry(entry, opts = {}) {
	const { fetch = defaultFetch, getTemplate = defaultGetTemplate, postProcessTemplate } = opts;
	const getPublicPath = opts.getPublicPath || opts.getDomain || defaultGetPublicPath;

	// entry is must

	// html entry
	if (typeof entry === 'string') {
		return importHTML(entry, {
			fetch,
			getPublicPath,
			getTemplate,
			postProcessTemplate,
		});
	}

	// config entry
	if (Array.isArray(entry.scripts) || Array.isArray(entry.styles)) {

		const { scripts = [], styles = [], html = '' } = entry;
		// 这两个方法是生成这样的注释 <!--  link styles replaced by import-html-entry -->html<!--   script scripts replaced by import-html-entry -->
		// 看了后续的方法，然后后面是将注释又换回真正的值
		const getHTMLWithStylePlaceholder = tpl => styles.reduceRight((html, styleSrc) => `${genLinkReplaceSymbol(styleSrc)}${html}`, tpl);
		const getHTMLWithScriptPlaceholder = tpl => scripts.reduce((html, scriptSrc) => `${html}${genScriptReplaceSymbol(scriptSrc)}`, tpl);

		return getEmbedHTML(getTemplate(getHTMLWithScriptPlaceholder(getHTMLWithStylePlaceholder(html))), styles, { fetch }).then(embedHTML => ({
			/** style html scrip 整合文字 */
			template: embedHTML,
			/** public path */
			assetPublicPath: getPublicPath(entry),
			/** get script 方法 */
			getExternalScripts: () => getExternalScripts(scripts, fetch),
			/** get style 方法 */
			getExternalStyleSheets: () => getExternalStyleSheets(styles, fetch),
			/** 执行 script 感觉有点沙箱的效果 */
			execScripts: (proxy, strictGlobal, opts = {}) => {
				if (!scripts.length) {
					return Promise.resolve();
				}
				return execScripts(scripts[scripts.length - 1], scripts, proxy, {
					fetch,
					strictGlobal,
					...opts,
				});
			},
		}));

	} else {
		throw new SyntaxError('entry scripts or styles should be array!');
	}
}
