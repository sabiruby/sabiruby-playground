# 文字列とシンボルの挙動（組込みクラスの章）。MRB_UTF8_STRING 無しのビルド
s = "あいう"
p [s.length, s.bytesize, s[0], s.reverse.length, s.upcase == s]
a = "x"; b = "x"
p [a.equal?(b), a.frozen?, 3.times.map { "x".object_id }.uniq.size]
p [:sym.frozen?, :abcd.to_s, "dyn#{1}".to_sym == :dyn1]
begin; "ab".freeze << "c"; rescue => e; p [e.class, e.message]; end
