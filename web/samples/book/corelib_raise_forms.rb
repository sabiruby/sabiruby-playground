# raise の各形とメッセージの扱い（corelib 章「例外」の裏付け）
r = []
def rec(r, e) = r << [e.class, e.message]
begin; raise; rescue => e; rec(r, e); end
begin; raise "s"; rescue => e; rec(r, e); end
begin; raise TypeError; rescue => e; rec(r, e); end
begin; raise TypeError, "t"; rescue => e; rec(r, e); end
begin; raise TypeError.new("obj"), "new"; rescue => e; rec(r, e); end
begin; raise StandardError.new(:sym); rescue => e; r << e.message; end
begin; raise 42; rescue TypeError => e; r << e.message; end
r.each { |x| p x }
p RuntimeError.new("made").inspect, RuntimeError.new.inspect
p RuntimeError.new("made").backtrace
begin
  raise "outer"
rescue
  begin; raise; rescue => e; p [e.class, e.message]; end   # 再送出ではない
end
