-- Agent Console 起動アプリ（scripts/ac-install.sh が osacompile で ~/Applications/Agent Console.app を生成）
-- __AC_HOME__ は導入時に置換される。実処理は current の launch.sh（版の切替に追従する）。
-- do shell script は /bin/sh で実行され、対話シェルの設定は読まれない（TN2065）。
on run
	try
		do shell script "/bin/bash " & quoted form of "__AC_HOME__/current/ops/launcher/launch.sh"
	on error errMsg
		display dialog "Agent Console を開けませんでした: " & errMsg buttons {"OK"} default button "OK" with icon caution
	end try
end run
