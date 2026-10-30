// SPDX-License-Identifier: LicenseRef-OctoCode-Personal OR LicenseRef-OctoCode-Commercial
// Copyright (c) 2026 zillafan80@gmail.com. See the distribution's LICENSE.
import MarkdownBlock from "../common/MarkdownBlock"
import license from "../../generated/about/license.txt?raw"
import manual from "../../generated/about/manual.txt?raw"
import thirdParty from "../../generated/about/third-party.txt?raw"
import { Section } from "./Section"

export function OctoCodeAbout() {
	return (
		<Section className="gap-2 leading-snug [&>p]:my-0 [&>h3]:my-0">
			<h3>作者与授权</h3>
			<p>
				有合作需要请联系作者：<a href="mailto:zillafan80@gmail.com">zillafan80@gmail.com</a>
				{" / "}
				<a href="mailto:479729980@qq.com">479729980@qq.com</a>。
			</p>
			<p className="text-sm text-vscode-descriptionForeground">
				第三方作品及既有许可继续保留。个人非商业学习、自用免费，企业内部、受雇工作、收费服务与商业集成须取得作者书面授权。
			</p>
			{[
				["完整授权协议（离线）", license],
				["第三方许可与来源全文（离线）", thirdParty],
				["使用手册（离线）", manual],
			].map(([title, text]) => (
				<details key={title} className="mt-1">
					<summary className="cursor-pointer text-vscode-textLink-foreground">{title}</summary>
					<div className="mt-2 break-words" data-testid="about-document">
						<MarkdownBlock markdown={text} />
					</div>
				</details>
			))}
		</Section>
	)
}
