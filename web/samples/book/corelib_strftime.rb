# mruby-time と mruby-strftime。本家は libc の strftime に渡すが、
# ここには C ライブラリが無いので変換は自前で書いてある（時刻帯は UTC だけ）。

t = Time.gm(2026, 11, 21, 8, 11, 32)
p t
p [t.year, t.mon, t.day, t.hour, t.min, t.sec, t.wday, t.yday]

puts t.strftime("%Y-%m-%d %H:%M:%S")
puts t.strftime("%A, %B %e, %Y")       # %e は空白詰めの日
puts t.strftime("%a %b %d %I:%M %p")
puts t.strftime("%F %T %z %Z")
puts t.strftime("%j 日目 / 週の %u 番目")
puts t.strftime("%-d 日（旗 - で詰めない）")
puts t.strftime("%c | %x | %X")        # C ロケール
p t.to_i
puts Time.at(t.to_i).utc.strftime("%F %T")   # 秒から戻す

p (t + 60 * 60 * 24).strftime("%F")    # 1 日後
p Time.gm(2026, 1, 1).strftime("%j")
