cask "prismagram" do
  arch arm: "aarch64", intel: "x64"

  version "0.4.2"
  sha256 arm:   "26b7d72ce7a995e93b685fbe0bc7c6403285d504deab391919981b629690f303",
         intel: "137c026d70afe7b8a03204dccfdcac12bcd974e0d95a049da3577e1cc1618282"

  url "https://github.com/Kingvic300/Prismagram/releases/download/v#{version}/Prismagram_#{version}_#{arch}.dmg"
  name "Prismagram"
  desc "Prisma schema diagrams and a database client"
  homepage "https://kingvic300.github.io/Prismagram/"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: ">= :catalina"

  app "Prismagram.app"

  zap trash: "~/Library/Application Support/io.github.kingvic300.prismagram"

  caveats <<~EOS
    Prismagram is not code-signed yet. If macOS says it cannot be opened, run:
      xattr -dr com.apple.quarantine "#{appdir}/Prismagram.app"
  EOS
end
