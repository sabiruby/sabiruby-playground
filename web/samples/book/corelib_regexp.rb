# mruby-regexp: 正規表現。SabiRuby のエンジンは本家の NFA ではなく
# Rust の regex-automata なので、後戻りが要る構文は拒否される。

p "abc123def" =~ /(\d+)/     # マッチ位置
p $~[1]                       # 直前のマッチの 1 番目のグループ
p $1

m = /(?<year>\d{4})-(?<mon>\d\d)/.match("刊行は 2026-11 です")
p m[:year], m[:mon], m.begin(0)

p "a1b22c333".gsub(/\d+/) { |d| "<#{d.size}>" }
p "x, y ;z".split(/\s*[,;]\s*/)
p "cat bat mat".scan(/\wat/)
p "Hello" =~ /\A[[:upper:]][[:lower:]]+\z/

case "2026-11-21"
when /\A(\d+)-(\d+)-(\d+)\z/ then p [$1.to_i, $2.to_i, $3.to_i]
end

# 有限オートマトンに無い構文は、コンパイル時に RegexpError で断る
["(a)\\1", "a(?=b)", "(?<=a)b", "a*+", "\\p{L}"].each do |src|
  begin
    Regexp.new(src)
  rescue RegexpError => e
    puts "#{src.inspect}: #{e.message}"
  end
end
