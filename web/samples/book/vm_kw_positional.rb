# キーワード仮引数の無いメソッドにキーワード引数を渡すと末尾の Hash になる（ENTER の kd=0）
def plain(*a) = a
def two(a, b = nil) = [a, b]
p plain(1, k: 2), plain(**{x: 1}), two(1, k: 2), two(k: 2)
h = {z: 9}
p plain(1, **h), plain(1, **{})
